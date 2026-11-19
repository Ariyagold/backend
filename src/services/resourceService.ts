import { eq, and, desc, asc, isNull } from "drizzle-orm";
import { createHash } from "node:crypto";
import { db } from "../db/client.js";
import { resources, publishers, verifications, moderationEvents } from "../db/schema.js";
import { uploadFile, deleteFile } from "../storage/supabaseStorage.js";
import { hashFileResource, hashLinkResource } from "../utils/crypto.js";
import { createTtlCache, createSingleFlight } from "../lib/ttlCache.js";
import { config } from "../config.js";
import { enqueueWebhookEvent } from "./webhookService.js";
import { enqueueStorageCleanup, enqueueThumbnailJob } from "./workerQueue.js";

// Short-lived cache for catalog/preview reads (issue #115). These endpoints are
// hit far more often than resources change, so a small TTL cuts repeated DB
// work while keeping newly published/delisted items fresh within seconds.
const CATALOG_KEY = "catalog";
const metaKey = (id: string) => `meta:${id}`;
const readCache = createTtlCache<unknown>({
  defaultTtlMs: config.CATALOG_CACHE_TTL_MS,
  cacheName: "catalog_read",
});

// Single-flight loaders (#225): concurrent misses for the same key share one
// DB load instead of each issuing its own query. Distinct keys stay
// independent, and a failed load clears its pending entry so it can be retried.
const catalogFlight = createSingleFlight<Awaited<ReturnType<typeof queryCatalog>>>();
const metaFlight = createSingleFlight<Awaited<ReturnType<typeof queryResourceMeta>>>();

// Per-filter-combination catalog response cache (#316). Keyed by a normalized
// filter/sort/pagination key so identical queries skip the filter/sort/paginate
// recompute entirely. Bounded (FIFO) so high-cardinality inputs (price/search)
// can't grow keys unbounded.
const pageCache = createTtlCache<unknown>({
  defaultTtlMs: config.CATALOG_CACHE_TTL_MS,
  maxSize: config.CATALOG_CACHE_MAX_KEYS,
  cacheName: "catalog_page",
});

// Drop cached reads affected by a write. The catalog (the listed set) and every
// per-filter response are invalidated, since any write can change any filtered
// view; the specific resource's preview is dropped too when known.
function invalidateReads(resourceId?: string): void {
  readCache.delete(CATALOG_KEY);
  pageCache.clear();
  if (resourceId) readCache.delete(metaKey(resourceId));
}

/** Admin moderation delist (any publisher). Returns null when the id is unknown. */
export async function adminDelistResource(
  id: string,
  options: { reason?: string; actor?: string } = {},
) {
  // The delist and its audit record commit atomically (#179): if the audit
  // insert fails, the transaction rolls back the delist too, so there is
  // never a committed moderation action without its durable audit record.
  const resource = await db.transaction(async (tx) => {
    const [updated] = await tx
      .update(resources)
      .set({ listed: false, adminDelistedAt: new Date() })
      .where(eq(resources.id, id))
      .returning({ id: resources.id });
    if (!updated) return null;

    await tx.insert(moderationEvents).values({
      resourceId: updated.id,
      action: "admin_delist",
      reason: options.reason ?? null,
      actor: options.actor ?? "admin",
    });

    return updated;
  });
  if (!resource) return null;

  invalidateReads(resource.id);
  return resource;
}

/** Resources held for manual verification review, oldest first (#188). */
export async function listVerificationReviewQueue(limit = 50, offset = 0) {
  return db
    .select({
      id: resources.id,
      title: resources.title,
      publisherId: resources.publisherId,
      verificationId: resources.verificationId,
      createdAt: resources.createdAt,
    })
    .from(resources)
    .where(and(eq(resources.verificationStatus, "review_required"), isNull(resources.adminDelistedAt)))
    .orderBy(asc(resources.createdAt))
    .limit(limit)
    .offset(offset);
}

export type ReviewResolution =
  | { ok: true; id: string; status: "verified" | "rejected" }
  | { ok: false; error: "not_found" | "delisted" | "not_in_review" };

/**
 * Resolve a held verification (#188). Records decision + reason + actor in
 * moderation_events in the same transaction. Admin-delisted resources can
 * never be relisted by an approval.
 */
export async function resolveVerificationReview(
  id: string,
  input: { decision: "approve" | "reject"; reason: string; actor: string },
): Promise<ReviewResolution> {
  const result = await db.transaction(async (tx): Promise<ReviewResolution> => {
    const [current] = await tx
      .select({
        status: resources.verificationStatus,
        adminDelistedAt: resources.adminDelistedAt,
      })
      .from(resources)
      .where(eq(resources.id, id))
      .limit(1);
    if (!current) return { ok: false, error: "not_found" };
    if (current.adminDelistedAt) return { ok: false, error: "delisted" };
    if (current.status !== "review_required") return { ok: false, error: "not_in_review" };

    const approve = input.decision === "approve";
    const [updated] = await tx
      .update(resources)
      .set({ verificationStatus: approve ? "verified" : "rejected", listed: approve })
      .where(
        and(
          eq(resources.id, id),
          eq(resources.verificationStatus, "review_required"),
          isNull(resources.adminDelistedAt),
        ),
      )
      .returning({ id: resources.id });
    if (!updated) return { ok: false, error: "not_in_review" };

    await tx.insert(moderationEvents).values({
      resourceId: id,
      action: approve ? "verification_review_approve" : "verification_review_reject",
      reason: input.reason,
      actor: input.actor,
    });
    return { ok: true, id, status: approve ? "verified" : "rejected" };
  });
  if (result.ok) invalidateReads(id);
  return result;
}

/** Test helper — clear the read caches between cases. */
export function __resetCatalogCache(): void {
  readCache.clear();
  pageCache.clear();
}

export async function createFileResource(data: {
  publisherId: string;
  title: string;
  description?: string;
  price: string;
  walletAddress: string;
  fileBuffer: Buffer;
  filename: string;
  mimeType: string;
}) {
  const contentHash = hashFileResource(data.fileBuffer, data.title);

  const [resource] = await db
    .insert(resources)
    .values({
      publisherId: data.publisherId,
      title: data.title,
      description: data.description,
      price: data.price,
      walletAddress: data.walletAddress,
      resourceType: "file",
      mimeType: data.mimeType,
      contentHash,
    })
    .returning();

  // Upload the file; if it fails, compensate by deleting the just-inserted row
  // so a failed upload leaves no orphan resource behind (issue #88).
  let storagePath: string;
  try {
    storagePath = await uploadFile(resource.id, data.fileBuffer, data.filename, data.mimeType);
  } catch (err) {
    try {
      await db.delete(resources).where(eq(resources.id, resource.id));
    } catch (cleanupErr) {
      const { getLogger } = await import("../lib/logger.js");
      getLogger().error(
        { event: "upload_rollback_failed", resourceId: resource.id, err: cleanupErr },
        "failed to remove resource row after upload failure",
      );
    }
    throw err;
  }

  const [updated] = await db
    .update(resources)
    .set({ storagePath })
    .where(eq(resources.id, resource.id))
    .returning();

  invalidateReads(updated.id);

  // Thumbnail generation is deferred to a worker so the publish request never
  // blocks on `sharp` (issue #89). The worker enforces the pixel limit.
  if (data.mimeType.startsWith("image/")) {
    try {
      await enqueueThumbnailJob({
        resourceId: resource.id,
        fileBuffer: data.fileBuffer,
        filename: data.filename,
      });
    } catch (err) {
      const { getLogger } = await import("../lib/logger.js");
      getLogger().error(
        { event: "thumbnail_enqueue_failed", resourceId: resource.id, err },
        "failed to enqueue thumbnail generation job",
      );
    }
  }

  return updated;
}

export async function createLinkResource(data: {
  publisherId: string;
  title: string;
  description?: string;
  price: string;
  walletAddress: string;
  externalUrl: string;
}) {
  const [resource] = await db
    .insert(resources)
    .values({
      publisherId: data.publisherId,
      title: data.title,
      description: data.description,
      price: data.price,
      walletAddress: data.walletAddress,
      resourceType: "link",
      externalUrl: data.externalUrl,
      contentHash: hashLinkResource(data.externalUrl, data.title),
    })
    .returning();

  invalidateReads(resource.id);
  return resource;
}

export async function getResourceById(id: string) {
  return db
    .select()
    .from(resources)
    .where(eq(resources.id, id))
    .then((rows) => rows[0] ?? null);
}

export type CatalogSort = "newest" | "price_asc" | "price_desc" | "title";

export type CatalogListFilters = {
  verificationStatus?: "verified" | "pending" | "rejected";
  minPrice?: string;
  maxPrice?: string;
  search?: string;
  resourceType?: "file" | "link";
  owner?: string;
  /**
   * Tag filter (#222). Matching is exact (case-insensitive) and multiple tags
   * are combined with AND semantics: a resource must carry every requested tag.
   * Duplicates are ignored; the caller validates the count limit.
   */
  tags?: string[];
  sort?: CatalogSort;
  limit?: number;
  offset?: number;
};

export type CatalogPage<T> = {
  items: T[];
  total: number;
  limit: number;
  offset: number;
  nextOffset: number | null;
};

const CATALOG_DEFAULT_LIMIT = 20;

// Locale-independent title comparison (#108). `localeCompare` without an
// explicit locale depends on the host's ICU/locale, so the same catalog could
// order differently across machines. Comparing lowercased strings with
// `<`/`>` uses code-unit order, which is stable everywhere.
function compareTitles(a: string, b: string): number {
  const la = a.toLowerCase();
  const lb = b.toLowerCase();
  if (la < lb) return -1;
  if (la > lb) return 1;
  return 0;
}

function sortRows<
  T extends { id: string; price: string; title: string; createdAt: Date | string },
>(rows: T[], sort: CatalogSort): T[] {
  // "newest" is the default — handled by ORDER BY created_at DESC, id DESC in
  // queryCatalog (#287, #108).
  if (sort === "newest" || !sort) return rows;

  const sorted = [...rows];
  switch (sort) {
    case "price_asc":
      sorted.sort((a, b) => parseFloat(a.price) - parseFloat(b.price) || compareIds(a.id, b.id));
      break;
    case "price_desc":
      sorted.sort((a, b) => parseFloat(b.price) - parseFloat(a.price) || compareIds(a.id, b.id));
      break;
    case "title":
      // Deterministic title order with an id tiebreaker so equal titles never
      // straddle page boundaries (#108).
      sorted.sort((a, b) => compareTitles(a.title, b.title) || compareIds(a.id, b.id));
      break;
  }
  return sorted;
}

// Stable id tiebreaker: descending id order, matching the catalog's
// `created_at DESC, id DESC` ordering.
function compareIds(a: string, b: string): number {
  if (a < b) return 1;
  if (a > b) return -1;
  return 0;
}

async function queryCatalog() {
  return db
    .select({
      id: resources.id,
      title: resources.title,
      description: resources.description,
      price: resources.price,
      resourceType: resources.resourceType,
      mimeType: resources.mimeType,
      thumbnailPath: resources.thumbnailPath,
      verificationStatus: resources.verificationStatus,
      tags: resources.tags,
      publisherName: publishers.name,
      walletAddress: resources.walletAddress,
      createdAt: resources.createdAt,
    })
    .from(resources)
    .innerJoin(publishers, eq(resources.publisherId, publishers.id))
    .where(eq(resources.listed, true))
    // `id DESC` is a stable tiebreaker so rows sharing a `created_at` have a
    // total order and pagination never duplicates or skips them (#108).
    .orderBy(desc(resources.createdAt), desc(resources.id));
}

async function getCachedCatalogRows(): Promise<Awaited<ReturnType<typeof queryCatalog>>> {
  const cached = readCache.get(CATALOG_KEY);
  if (cached !== undefined) {
    return cached as Awaited<ReturnType<typeof queryCatalog>>;
  }
  // Single-flight (#225): a cold/expired catalog key triggers one query even
  // when many requests arrive concurrently.
  return catalogFlight.load(CATALOG_KEY, async () => {
    const rows = await queryCatalog();
    readCache.set(CATALOG_KEY, rows);
    return rows;
  });
}

function applyCatalogFilters<
  T extends {
    title: string;
    description: string | null;
    price: string;
    verificationStatus: string;
    resourceType: string;
    publisherName: string;
    walletAddress: string;
    tags?: string[] | null;
  },
>(rows: T[], filters?: CatalogListFilters): T[] {
  if (!filters) return rows;

  const search = filters.search?.toLowerCase();
  const owner = filters.owner?.toLowerCase();
  // Exact, case-insensitive tag matching with AND semantics (#222): every
  // requested tag must be present on the row.
  const requiredTags = filters.tags?.length
    ? [...new Set(filters.tags.map((t) => t.trim().toLowerCase()).filter((t) => t.length > 0))]
    : [];
  // Prices are stored as decimal strings (e.g. "0.50"); compare numerically and
  // inclusively, parsing only at the point of comparison.
  const min = filters.minPrice !== undefined ? parseFloat(filters.minPrice) : undefined;
  const max = filters.maxPrice !== undefined ? parseFloat(filters.maxPrice) : undefined;

  return rows.filter((r) => {
    if (
      search &&
      !(r.title?.toLowerCase().includes(search) || r.description?.toLowerCase().includes(search))
    ) {
      return false;
    }
    if (min !== undefined && parseFloat(r.price) < min) return false;
    if (max !== undefined && parseFloat(r.price) > max) return false;
    if (filters.verificationStatus && r.verificationStatus !== filters.verificationStatus) {
      return false;
    }
    if (filters.resourceType && r.resourceType !== filters.resourceType) return false;
    if (requiredTags.length > 0) {
      const rowTags = new Set((r.tags ?? []).map((t) => t.toLowerCase()));
      if (!requiredTags.every((t) => rowTags.has(t))) return false;
    }
    if (
      owner &&
      !(
        r.publisherName?.toLowerCase().includes(owner) ||
        r.walletAddress?.toLowerCase().includes(owner)
      )
    ) {
      return false;
    }
    return true;
  });
}

// Normalized, order-stable cache key for a filter/sort/pagination combination
// (#316). Undefined fields are omitted and `search` is trimmed/lowercased so
// equivalent queries share an entry; keys are emitted in sorted order for
// determinism. `kind` separates the list vs. count views of the same filters.
function catalogCacheKey(kind: "list" | "count", filters?: CatalogListFilters): string {
  if (!filters) return `${kind}:all`;
  const norm: Record<string, string | number> = {};
  if (filters.verificationStatus) norm.vs = filters.verificationStatus;
  if (filters.minPrice !== undefined) norm.min = filters.minPrice;
  if (filters.maxPrice !== undefined) norm.max = filters.maxPrice;
  if (filters.search) {
    const q = filters.search.trim().toLowerCase();
    if (q) norm.q = q;
  }
  if (filters.resourceType) norm.rt = filters.resourceType;
  if (filters.owner) {
    const o = filters.owner.trim().toLowerCase();
    if (o) norm.owner = o;
  }
  if (filters.tags?.length) {
    // Sorted + lowercased so tag order never splits the cache (#222).
    const tags = [...new Set(filters.tags.map((t) => t.trim().toLowerCase()).filter((t) => t.length > 0))].sort();
    if (tags.length) norm.tags = tags.join(",");
  }
  if (filters.sort) norm.sort = filters.sort;
  // Count ignores pagination (#162), so omit limit/offset from the count key so
  // all pages of the same filter share one cached total.
  if (kind === "list") {
    if (filters.limit !== undefined) norm.limit = filters.limit;
    if (filters.offset !== undefined) norm.offset = filters.offset;
  }
  return `${kind}:` + JSON.stringify(norm, Object.keys(norm).sort());
}

// The full listed set is cached once under CATALOG_KEY; on top of that, each
// distinct filter/sort/pagination combination caches its computed response under
// a normalized key (#316) so popular identical queries skip the in-memory
// filter/sort/paginate work entirely. The per-filter cache is bounded (FIFO via
// CATALOG_CACHE_MAX_KEYS) so high-cardinality inputs (price, search) can't grow
// keys without limit, and it is cleared on any resource mutation.
//
// `sort` (#163) and `limit`/`offset` (#162) are applied after filtering, in that
// order, so pagination always walks a stable, sorted sequence. Omitting limit/offset
// preserves the historical "return everything" behavior for existing callers.
export async function listCatalog(
  filters?: CatalogListFilters,
): Promise<Awaited<ReturnType<typeof queryCatalog>>> {
  const cacheKey = catalogCacheKey("list", filters);
  const cached = pageCache.get(cacheKey);
  if (cached !== undefined) {
    return cached as Awaited<ReturnType<typeof queryCatalog>>;
  }

  const rows = await getCachedCatalogRows();
  const filtered = applyCatalogFilters(rows, filters);

  const result = ((): Awaited<ReturnType<typeof queryCatalog>> => {
    if (!filters) return filtered;
    const sorted = filters.sort ? sortRows(filtered, filters.sort) : filtered;
    if (filters.limit === undefined && filters.offset === undefined) return sorted;
    const offset = filters.offset ?? 0;
    const limit = filters.limit ?? CATALOG_DEFAULT_LIMIT;
    return sorted.slice(offset, offset + limit);
  })();

  pageCache.set(cacheKey, result);
  return result;
}

/** Total count of listed resources matching `filters`, ignoring limit/offset (#162). */
export async function countCatalog(filters?: CatalogListFilters): Promise<number> {
  const cacheKey = catalogCacheKey("count", filters);
  const cached = pageCache.get(cacheKey);
  if (cached !== undefined) return cached as number;

  const rows = await getCachedCatalogRows();
  const total = applyCatalogFilters(rows, filters).length;
  pageCache.set(cacheKey, total);
  return total;
}

async function queryResourceMeta(id: string) {
  return db
    .select({
      id: resources.id,
      title: resources.title,
      description: resources.description,
      price: resources.price,
      resourceType: resources.resourceType,
      mimeType: resources.mimeType,
      verificationStatus: resources.verificationStatus,
      tags: resources.tags,
      publisherName: publishers.name,
      publisherWallet: resources.walletAddress,
      thumbnailPath: resources.thumbnailPath,
      onchainStatus: resources.onchainStatus,
      onchainTxHash: resources.onchainTxHash,
      contentHash: resources.contentHash,
      createdAt: resources.createdAt,
    })
    .from(resources)
    .innerJoin(publishers, eq(resources.publisherId, publishers.id))
    .where(eq(resources.id, id))
    .then((rows) => rows[0] ?? null);
}

type ResourceMeta = NonNullable<Awaited<ReturnType<typeof queryResourceMeta>>>;

/**
 * Deterministic validator for public resource metadata (#223). Hashes the
 * fields exposed by the public metadata read so any metadata change yields a
 * new ETag. Private/owner-only responses must not reuse this value.
 */
export function computeResourceEtag(meta: ResourceMeta): string {
  const createdAt =
    meta.createdAt instanceof Date ? meta.createdAt.toISOString() : String(meta.createdAt);
  const payload = JSON.stringify([
    meta.id,
    meta.title,
    meta.description ?? null,
    meta.price,
    meta.resourceType,
    meta.mimeType ?? null,
    meta.verificationStatus,
    meta.thumbnailPath ?? null,
    meta.onchainStatus ?? null,
    meta.contentHash ?? null,
    createdAt,
  ]);
  return `"${createHash("sha256").update(payload).digest("hex")}"`;
}

export async function getResourceMeta(
  id: string,
): Promise<Awaited<ReturnType<typeof queryResourceMeta>>> {
  const cached = readCache.get(metaKey(id));
  if (cached !== undefined) return cached as Awaited<ReturnType<typeof queryResourceMeta>>;

  // Single-flight (#225): concurrent misses for one id share a single query.
  return metaFlight.load(metaKey(id), async () => {
    const result = await queryResourceMeta(id);
    // Only cache hits; a 404 (null) stays uncached so a freshly created resource
    // becomes visible immediately.
    if (result) readCache.set(metaKey(id), result);
    return result;
  });
}

/**
 * Public metadata read with its stable ETag (#223). Returns null when the
 * resource does not exist. Callers compare the ETag against `If-None-Match`
 * and answer 304 when it matches.
 */
export async function getResourceMetaWithEtag(
  id: string,
): Promise<{ meta: ResourceMeta; etag: string } | null> {
  const meta = await getResourceMeta(id);
  if (!meta) return null;
  return { meta, etag: computeResourceEtag(meta) };
}

/**
 * Delist a resource: flip `listed` to false in Postgres, drop stored files, and
 * (issue #218) sync the change on-chain so the vault registry's `listed` flag
 * matches the API.
 *
 * The on-chain delist is best-effort and never blocks the DB delist:
 *  - Resources that were never registered on-chain (`onchainStatus !==
 *    "registered"`) skip the chain call entirely and delist cleanly.
 *  - If the on-chain call fails, the DB delist still stands and the failure is
 *    logged for reconciliation rather than surfaced to the caller.
 *
 * `onChainDelist` is injectable so tests can assert both paths without touching
 * Soroban; it defaults to the real registry-signed delist.
 */
export async function delistResource(
  id: string,
  publisherId: string,
  // Injectable for tests. Left out, it lazily loads the real registry-signed
  // delist; the lazy import keeps `resourceService` free of a load-time Stellar
  // client so unrelated tests don't need to mock the registry.
  onChainDelist?: (resourceId: string) => Promise<{ success: boolean; error?: string }>,
) {
  const [resource] = await db
    .update(resources)
    .set({ listed: false })
    .where(and(eq(resources.id, id), eq(resources.publisherId, publisherId)))
    .returning();

  if (!resource) return null;

  invalidateReads(resource.id);

  void enqueueWebhookEvent(resource.publisherId, "resource.delisted", {
    resourceId: resource.id,
    title: resource.title,
  });

  // Storage cleanup is best-effort: the DB delist already stands, so a failed
  // delete must not surface as an error to the caller (issue #87). Log the
  // failure and queue a retry so the orphaned object is removed later.
  for (const path of [resource.storagePath, resource.thumbnailPath]) {
    if (!path) continue;
    try {
      await deleteFile(path);
    } catch (err) {
      const { getLogger } = await import("../lib/logger.js");
      getLogger().error(
        {
          event: "delist_storage_cleanup_failed",
          resourceId: resource.id,
          storagePath: path,
          err,
        },
        "failed to delete stored file during delist; queued for retry",
      );
      try {
        await enqueueStorageCleanup({ resourceId: resource.id, storagePath: path });
      } catch (queueErr) {
        getLogger().error(
          { event: "delist_storage_cleanup_enqueue_failed", resourceId: resource.id, storagePath: path, err: queueErr },
          "failed to enqueue storage cleanup retry",
        );
      }
    }
  }

  // Only registered resources exist on-chain; anything else delists DB-only.
  if (resource.onchainStatus === "registered") {
    const { getLogger } = await import("../lib/logger.js");
    try {
      const delist = onChainDelist ?? (await import("./registryClient.js")).delistOnChain;
      const result = await delist(resource.id);
      if (!result.success) {
        getLogger().warn(
          { event: "delist_onchain_sync", resourceId: resource.id, error: result.error },
          "DB delist succeeded but on-chain delist failed; chain state may be stale",
        );
      }
    } catch (err) {
      getLogger().error(
        { event: "delist_onchain_sync", resourceId: resource.id, err },
        "unexpected error during on-chain delist sync",
      );
    }
  }

  return resource;
}

export async function getVerificationDetails(resourceId: string) {
  const resource = await db
    .select({
      id: resources.id,
      title: resources.title,
      verificationStatus: resources.verificationStatus,
      verificationId: resources.verificationId,
      listed: resources.listed,
      createdAt: resources.createdAt,
    })
    .from(resources)
    .where(eq(resources.id, resourceId))
    .then((rows) => rows[0] ?? null);

  if (!resource) return null;

  let verification = null;
  if (resource.verificationId) {
    verification = await db
      .select()
      .from(verifications)
      .where(eq(verifications.id, resource.verificationId))
      .then((rows) => rows[0] ?? null);
  }

  return {
    resourceId: resource.id,
    title: resource.title,
    status: resource.verificationStatus,
    listed: resource.listed,
    publishedAt: resource.createdAt,
    verification: verification
      ? {
          isOriginal: verification.isOriginal,
          confidence: verification.confidence,
          flags: verification.flags ? JSON.parse(verification.flags) : [],
          checkedAt: verification.checkedAt,
        }
      : null,
  };
}
