/**
 * SynapsVault — Admin Routes
 * Protected by X-Admin-Key header. Never expose to the public internet
 * without an additional layer (VPN / IP whitelist recommended).
 */
import { createHash, timingSafeEqual } from "node:crypto";
import { Router, type NextFunction, type Request, type Response } from "express";
import { db } from "../db/client.js";
import { resources, publishers, payments, moderationEvents } from "../db/schema.js";
import { desc, asc, count, and, or, eq, ne, gte, lte, inArray, sql, type SQL } from "drizzle-orm";
import { getLogger } from "../lib/logger.js";
import { AppError } from "../lib/errors.js";
import {
  adminDelistResource,
  adminRestoreResource,
  listVerificationReviewQueue,
  resolveVerificationReview,
} from "../services/resourceService.js";
import { config } from "../config.js";

const router = Router();

function digest(value: string): Buffer {
  return createHash("sha256").update(value).digest();
}

/** Constant-time check of X-Admin-Key against ADMIN_API_KEY (disabled when unset). */
function adminAuth(req: Request, _res: Response, next: NextFunction) {
  const expected = config.ADMIN_API_KEY;
  const key = req.headers["x-admin-key"];
  if (!expected || typeof key !== "string" || !timingSafeEqual(digest(key), digest(expected))) {
    throw new AppError("UNAUTHORIZED", "Unauthorized");
  }
  next();
}

// ── Query parameter validation policy (#226) ────────────────────────────────
//
// Admin endpoints use a strict, explicit query policy:
//   * Repeated parameters (arrays) and nested objects are ALWAYS rejected
//     with VALIDATION_ERROR — there is no "first value wins" behaviour.
//   * Unknown keys are rejected with VALIDATION_ERROR so typos surface
//     immediately instead of being silently ignored.
//   * Empty-string values are treated as "absent" for optional filters.
//
// Each endpoint declares its allowed key set via `assertQueryKeys` and reads
// values through the typed helpers below, which enforce the string-only rule.

/** Reject repeated (array) or nested (object) query values for a single key. */
function assertScalarQuery(value: unknown, name: string): string | undefined {
  if (value === undefined) return undefined;
  if (Array.isArray(value)) {
    throw new AppError(
      "VALIDATION_ERROR",
      `Invalid ${name}: repeated parameters are not supported; provide a single value`,
    );
  }
  if (typeof value === "object" && value !== null) {
    throw new AppError("VALIDATION_ERROR", `Invalid ${name}: expected a single string value`);
  }
  if (typeof value !== "string") {
    throw new AppError("VALIDATION_ERROR", `Invalid ${name}: expected a single string value`);
  }
  return value;
}

/** Reject any query key not present in `allowed`. */
function assertQueryKeys(query: Request["query"], allowed: readonly string[]): void {
  const allowedSet = new Set(allowed);
  for (const key of Object.keys(query)) {
    if (!allowedSet.has(key)) {
      throw new AppError(
        "VALIDATION_ERROR",
        `Unknown query parameter '${key}'; allowed: ${allowed.join(", ")}`,
      );
    }
  }
}

/** Read an optional string query param, enforcing scalar-only semantics. */
function optionalStringQuery(query: Request["query"], name: string): string | undefined {
  const raw = assertScalarQuery(query[name], name);
  if (raw === undefined || raw === "") return undefined;
  return raw;
}

/** Parse an optional ISO date query param; throws VALIDATION_ERROR when invalid. */
function parseDateParam(value: unknown, name: string): Date | undefined {
  const raw = assertScalarQuery(value, name);
  if (raw === undefined || raw === "") return undefined;
  const parsed = new Date(raw);
  if (Number.isNaN(parsed.getTime())) {
    throw new AppError("VALIDATION_ERROR", `Invalid ${name} date`);
  }
  return parsed;
}

/** Parse a strict positive-integer query param; throws VALIDATION_ERROR when invalid. */
function parsePositiveIntParam(value: unknown, name: string, max: number, fallback: number): number {
  const raw = assertScalarQuery(value, name);
  if (raw === undefined || raw === "") return fallback;
  if (!/^\d+$/.test(raw)) {
    throw new AppError("VALIDATION_ERROR", `Invalid ${name}: expected an integer 1-${max}`);
  }
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > max) {
    throw new AppError("VALIDATION_ERROR", `Invalid ${name}: expected an integer 1-${max}`);
  }
  return parsed;
}

/** Parse a strict non-negative-integer query param; throws VALIDATION_ERROR when invalid. */
function parseNonNegativeIntParam(value: unknown, name: string): number | undefined {
  const raw = assertScalarQuery(value, name);
  if (raw === undefined || raw === "") return undefined;
  if (!/^\d+$/.test(raw)) {
    throw new AppError("VALIDATION_ERROR", `Invalid ${name}: expected a non-negative integer`);
  }
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed)) {
    throw new AppError("VALIDATION_ERROR", `Invalid ${name}: expected a non-negative integer`);
  }
  return parsed;
}

/** GET /admin/stats */
router.get("/admin/stats", adminAuth, async (_req, res) => {
  const [[totalResources], [totalPublishers], [totalPayments]] = await Promise.all([
    db.select({ count: count() }).from(resources),
    db.select({ count: count() }).from(publishers),
    db.select({ count: count() }).from(payments),
  ]);

  res.json({
    resources:  totalResources.count,
    publishers: totalPublishers.count,
    payments:   totalPayments.count,
    uptime:     process.uptime(),
    timestamp:  new Date().toISOString(),
  });
});

/** POST /admin/delist/:id */
router.post("/admin/delist/:id", adminAuth, async (req, res) => {
  const id = req.params.id as string;
  const reason = typeof req.body?.reason === "string" ? req.body.reason.trim() || undefined : undefined;
  // Use a digest of the admin key as the actor identifier so the audit log
  // is attributable without storing the raw key.
  const actor = adminActor(req);
  const resource = await adminDelistResource(id, { reason, actor });
  if (!resource) {
    throw new AppError("NOT_FOUND", "Resource not found");
  }
  getLogger().warn({ resourceId: id, event: "admin_delist", actor, reason }, "resource delisted by admin");
  res.json({ success: true, id, delistedAt: new Date().toISOString() });
});

/**
 * POST /admin/restore/:id — body { reason } (#229)
 *
 * Explicit reversal of a mistaken administrative delist. Requires a
 * non-empty `reason`; the service records an immutable moderation event and
 * re-checks verification / chain-state eligibility before clearing the
 * delist flag. Prior moderation history is preserved.
 */
router.post("/admin/restore/:id", adminAuth, async (req, res) => {
  const id = req.params.id as string;
  const reason = typeof req.body?.reason === "string" ? req.body.reason.trim() : "";
  if (!reason) throw new AppError("VALIDATION_ERROR", "reason is required");
  const actor = adminActor(req);
  const result = await adminRestoreResource(id, { reason, actor });
  if (!result.ok) {
    if (result.error === "not_found") throw new AppError("NOT_FOUND", "Resource not found");
    if (result.error === "not_delisted") {
      throw new AppError("CONFLICT", "Resource is not administratively delisted");
    }
    if (result.error === "ineligible") {
      throw new AppError(
        "FORBIDDEN",
        "Resource is not eligible for restoration (verification or chain state does not permit relisting)",
      );
    }
    throw new AppError("CONFLICT", "Resource could not be restored");
  }
  getLogger().warn({ resourceId: id, event: "admin_restore", actor, reason }, "resource restored by admin");
  res.json({ success: true, id, status: result.status });
});

function adminActor(req: Request): string {
  const rawKey = req.headers["x-admin-key"] as string;
  return `admin:${createHash("sha256").update(rawKey).digest("hex").slice(0, 12)}`;
}

/** GET /admin/verification-reviews — queue of low-confidence holds (#188) */
router.get("/admin/verification-reviews", adminAuth, async (req, res) => {
  assertQueryKeys(req.query, ["limit", "page"]);
  const limit = parsePositiveIntParam(req.query.limit, "limit", 200, 50);
  const page = parsePositiveIntParam(req.query.page, "page", Number.MAX_SAFE_INTEGER, 1);
  const entries = await listVerificationReviewQueue(limit, (page - 1) * limit);
  res.json({ page, limit, entries });
});

/** POST /admin/verification-reviews/:id/resolve — body { decision, reason } (#188) */
router.post("/admin/verification-reviews/:id/resolve", adminAuth, async (req, res) => {
  const id = req.params.id as string;
  const decision = req.body?.decision;
  const reason = typeof req.body?.reason === "string" ? req.body.reason.trim() : "";
  if (decision !== "approve" && decision !== "reject") {
    throw new AppError("VALIDATION_ERROR", "decision must be 'approve' or 'reject'");
  }
  if (!reason) throw new AppError("VALIDATION_ERROR", "reason is required");
  const actor = adminActor(req);
  const result = await resolveVerificationReview(id, { decision, reason, actor });
  if (!result.ok) {
    if (result.error === "not_found") throw new AppError("NOT_FOUND", "Resource not found");
    if (result.error === "delisted") {
      throw new AppError("FORBIDDEN", "Resource was delisted by an administrator and cannot be relisted");
    }
    throw new AppError("CONFLICT", "Resource is not awaiting verification review");
  }
  getLogger().info({ resourceId: id, event: "verification_review_resolved", actor, decision, reason }, "verification review resolved");
  res.json({ success: true, id, status: result.status });
});

/**
 * GET /admin/audit
 *
 * Query params (unknown keys rejected):
 *   resourceId — exact resource id filter
 *   payer      — exact payer address filter
 *   from / to  — inclusive ISO-8601 bounds on paidAt
 *   limit      — 1-200 (default 50)
 *   page       — >= 1 (default 1)
 */
router.get("/admin/audit", adminAuth, async (req, res) => {
  assertQueryKeys(req.query, ["limit", "page", "resourceId", "payer", "from", "to"]);
  const limit = parsePositiveIntParam(req.query.limit, "limit", 200, 50);
  const page  = parsePositiveIntParam(req.query.page, "page", Number.MAX_SAFE_INTEGER, 1);
  const offset = (page - 1) * limit;

  const resourceId = optionalStringQuery(req.query, "resourceId");
  const payer = optionalStringQuery(req.query, "payer");
  const from = parseDateParam(req.query.from, "from");
  const to = parseDateParam(req.query.to, "to");
  if (from !== undefined && to !== undefined && from.getTime() > to.getTime()) {
    throw new AppError("VALIDATION_ERROR", "Invalid date range: 'from' must not be after 'to'");
  }

  const conditions: SQL[] = [];
  if (resourceId !== undefined) conditions.push(eq(payments.resourceId, resourceId));
  if (payer !== undefined) conditions.push(eq(payments.payerAddress, payer));
  if (from !== undefined) conditions.push(gte(payments.paidAt, from));
  if (to !== undefined) conditions.push(lte(payments.paidAt, to));

  const rows = await db
    .select({ id: payments.id, resourceId: payments.resourceId,
              payer: payments.payerAddress, amount: payments.amount, paidAt: payments.paidAt })
    .from(payments)
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .orderBy(desc(payments.paidAt), desc(payments.id))
    .limit(limit)
    .offset(offset);

  res.json({ page, limit, entries: rows });
});

/**
 * GET /admin/moderation-events
 *
 * Paginated, read-only moderation history for a resource. Requires the
 * `X-Admin-Key` header (same constant-time check as every /admin route);
 * requests without a valid key are rejected with 401 UNAUTHORIZED.
 *
 * Query params (unknown keys rejected):
 *   resourceId — exact resource id filter
 *   actor      — exact actor filter (e.g. "admin:<digest>")
 *   from / to  — inclusive ISO-8601 bounds on createdAt
 *   limit      — 1-200 (default 50)
 *   offset     — >= 0 (default 0); `page` is accepted as a convenience and
 *                translated to offset = (page - 1) * limit
 *
 * Returns immutable event rows (id, resourceId, actor, action, reason,
 * metadata, createdAt) newest first, plus `total` for the filtered set so
 * callers can paginate without a second request.
 */
router.get("/admin/moderation-events", adminAuth, async (req, res) => {
  assertQueryKeys(req.query, ["limit", "page", "offset", "resourceId", "actor", "from", "to"]);
  const limit = parsePositiveIntParam(req.query.limit, "limit", 200, 50);
  const page = parsePositiveIntParam(req.query.page, "page", Number.MAX_SAFE_INTEGER, 1);
  const rawOffset = parseNonNegativeIntParam(req.query.offset, "offset");
  const offset = rawOffset !== undefined ? rawOffset : (page - 1) * limit;

  const resourceId = optionalStringQuery(req.query, "resourceId");
  const actor = optionalStringQuery(req.query, "actor");
  const from = parseDateParam(req.query.from, "from");
  const to = parseDateParam(req.query.to, "to");

  const conditions: SQL[] = [];
  if (resourceId !== undefined) conditions.push(eq(moderationEvents.resourceId, resourceId));
  if (actor !== undefined) conditions.push(eq(moderationEvents.actor, actor));
  if (from !== undefined) conditions.push(gte(moderationEvents.createdAt, from));
  if (to !== undefined) conditions.push(lte(moderationEvents.createdAt, to));
  const where = conditions.length > 0 ? and(...conditions) : undefined;

  const [entries, [totalRow]] = await Promise.all([
    db
      .select({
        id: moderationEvents.id,
        resourceId: moderationEvents.resourceId,
        actor: moderationEvents.actor,
        action: moderationEvents.action,
        reason: moderationEvents.reason,
        metadata: moderationEvents.metadata,
        createdAt: moderationEvents.createdAt,
      })
      .from(moderationEvents)
      .where(where)
      .orderBy(desc(moderationEvents.createdAt), desc(moderationEvents.id))
      .limit(limit)
      .offset(offset),
    db.select({ count: count() }).from(moderationEvents).where(where),
  ]);

  res.json({
    page,
    limit,
    offset,
    total: Number(totalRow?.count ?? 0),
    entries,
  });
});

// ── Payment exceptions (settlement / delivery reconciliation) ───────────────

const SETTLEMENT_STATES = ["pending", "settled", "failed"] as const;
const DELIVERY_STATES = ["delivered", "undelivered"] as const;
const EXCEPTION_MAX_LIMIT = 200;
/** Upper bound on minAgeMinutes (1 year) so the cutoff can't overflow. */
const MAX_AGE_MINUTES = 525_600;

/** Parse a comma-separated enum list; undefined when absent. */
function parseEnumList<T extends string>(value: unknown, allowed: readonly T[], name: string): T[] | undefined {
  const raw = assertScalarQuery(value, name);
  if (raw === undefined || raw === "") return undefined;
  const items = [...new Set(raw.split(",").map((v) => v.trim()).filter(Boolean))];
  const bad = items.filter((v) => !(allowed as readonly string[]).includes(v));
  if (items.length === 0 || bad.length > 0) {
    throw new AppError("VALIDATION_ERROR", `Invalid ${name}: expected one or more of ${allowed.join(", ")}`);
  }
  return items as T[];
}

function parseMinAgeMinutes(value: unknown): number {
  const raw = assertScalarQuery(value, "minAgeMinutes");
  if (raw === undefined || raw === "") return 0;
  if (!/^\d+$/.test(raw) || Number(raw) > MAX_AGE_MINUTES) {
    throw new AppError("VALIDATION_ERROR", `Invalid minAgeMinutes: expected an integer 0-${MAX_AGE_MINUTES}`);
  }
  return Number(raw);
}

/**
 * GET /admin/payments/exceptions
 *
 * Reconciliation view of payments that need recovery. Query params
 * (unknown keys rejected):
 *   settlement     — comma list of pending|settled|failed
 *   delivery       — comma list of delivered|undelivered
 *   minAgeMinutes  — only rows paid at least this long ago (default 0)
 *   limit          — 1-200 (default 50); oldest first so the most overdue
 *                    rows are always inside the bound
 * With neither settlement nor delivery given, the default exception set is
 * "not settled OR undelivered". `summary` counts the *whole* matching set
 * (not just the returned page) so operators can size the backlog.
 */
router.get("/admin/payments/exceptions", adminAuth, async (req, res) => {
  assertQueryKeys(req.query, ["settlement", "delivery", "minAgeMinutes", "limit"]);
  const settlement = parseEnumList(req.query.settlement, SETTLEMENT_STATES, "settlement");
  const delivery = parseEnumList(req.query.delivery, DELIVERY_STATES, "delivery");
  const minAgeMinutes = parseMinAgeMinutes(req.query.minAgeMinutes);
  const limit = parsePositiveIntParam(req.query.limit, "limit", EXCEPTION_MAX_LIMIT, 50);

  const now = new Date();
  const cutoff = new Date(now.getTime() - minAgeMinutes * 60_000);

  const conditions: SQL[] = [lte(payments.paidAt, cutoff)];
  if (settlement) conditions.push(inArray(payments.status, settlement));
  if (delivery) conditions.push(inArray(payments.deliveryStatus, delivery));
  if (!settlement && !delivery) {
    conditions.push(or(ne(payments.status, "settled"), eq(payments.deliveryStatus, "undelivered"))!);
  }
  const where = and(...conditions);

  const [entries, [summaryRow]] = await Promise.all([
    db
      .select({
        id: payments.id,
        resourceId: payments.resourceId,
        payer: payments.payerAddress,
        recipient: payments.recipientAddress,
        amount: payments.amount,
        status: payments.status,
        deliveryStatus: payments.deliveryStatus,
        paidAt: payments.paidAt,
      })
      .from(payments)
      .where(where)
      .orderBy(asc(payments.paidAt), asc(payments.id))
      .limit(limit),
    db
      .select({
        total: sql<number>`count(*)::int`,
        pending: sql<number>`count(*) filter (where ${payments.status} = 'pending')::int`,
        settled: sql<number>`count(*) filter (where ${payments.status} = 'settled')::int`,
        failed: sql<number>`count(*) filter (where ${payments.status} = 'failed')::int`,
        delivered: sql<number>`count(*) filter (where ${payments.deliveryStatus} = 'delivered')::int`,
        undelivered: sql<number>`count(*) filter (where ${payments.deliveryStatus} = 'undelivered')::int`,
        under1h: sql<number>`count(*) filter (where ${payments.paidAt} > now() - interval '1 hour')::int`,
        from1hTo24h: sql<number>`count(*) filter (where ${payments.paidAt} <= now() - interval '1 hour' and ${payments.paidAt} > now() - interval '24 hours')::int`,
        from1dTo7d: sql<number>`count(*) filter (where ${payments.paidAt} <= now() - interval '24 hours' and ${payments.paidAt} > now() - interval '7 days')::int`,
        over7d: sql<number>`count(*) filter (where ${payments.paidAt} <= now() - interval '7 days')::int`,
        oldestPaidAt: sql<Date | string | null>`min(${payments.paidAt})`,
      })
      .from(payments)
      .where(where),
  ]);

  const s = summaryRow ?? {
    total: 0, pending: 0, settled: 0, failed: 0, delivered: 0, undelivered: 0,
    under1h: 0, from1hTo24h: 0, from1dTo7d: 0, over7d: 0, oldestPaidAt: null,
  };
  const oldest = s.oldestPaidAt ? new Date(s.oldestPaidAt) : null;
  const total = Number(s.total);

  res.json({
    filters: {
      settlement: settlement ?? null,
      delivery: delivery ?? null,
      minAgeMinutes,
      defaultExceptionSet: !settlement && !delivery,
    },
    limit,
    truncated: total > entries.length,
    entries: entries.map((e) => ({
      ...e,
      ageSeconds: Math.max(0, Math.floor((now.getTime() - new Date(e.paidAt).getTime()) / 1000)),
    })),
    summary: {
      total,
      bySettlement: { pending: Number(s.pending), settled: Number(s.settled), failed: Number(s.failed) },
      byDelivery: { delivered: Number(s.delivered), undelivered: Number(s.undelivered) },
      byAge: {
        under1h: Number(s.under1h),
        from1hTo24h: Number(s.from1hTo24h),
        from1dTo7d: Number(s.from1dTo7d),
        over7d: Number(s.over7d),
      },
      oldestPaidAt: oldest ? oldest.toISOString() : null,
      oldestAgeSeconds: oldest ? Math.max(0, Math.floor((now.getTime() - oldest.getTime()) / 1000)) : null,
    },
    generatedAt: now.toISOString(),
  });
});

export default router;