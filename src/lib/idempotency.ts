import { createHash } from "node:crypto";
import { config } from "../config.js";
import { createTtlCache } from "./ttlCache.js";

// Idempotency support for publish (issue #114). When a client sends an
// `Idempotency-Key`, the first completed publish is remembered so retries with
// the same key return the original response instead of creating a duplicate.
//
// An entry is either "in progress" (a publish is currently running for this
// key) or a stored result. The in-progress marker lets concurrent retries fail
// fast with 409 rather than racing to insert duplicates.
//
// Every record also carries a `fingerprint` of the request that reserved the
// key (#171): a retry with the same key but different metadata or file bytes
// doesn't get to replay (or race for) someone else's result — it's rejected
// as a conflict instead of silently returning an unrelated resource.

export interface IdempotentResult {
  status: number;
  body: unknown;
}

export type IdempotencyRecord =
  | { inProgress: true; fingerprint: string }
  | { inProgress: false; fingerprint: string; result: IdempotentResult };

// Keys are scoped per publisher so one publisher's key can't collide with or
// read another's result.
export function idempotencyCacheKey(publisherId: string, key: string): string {
  return `${publisherId}:${key}`;
}

// Canonical fingerprint of the fields that determine what a publish request
// produces. Two requests that hash to the same fingerprint are the request
// being retried verbatim; anything else reusing the same Idempotency-Key is a
// different request and must be rejected rather than replayed (#171).
export function computeIdempotencyFingerprint(input: {
  title?: unknown;
  description?: unknown;
  price?: unknown;
  walletAddress?: unknown;
  externalUrl?: unknown;
  fileContentHash?: string;
  filename?: string;
  mimeType?: string;
}): string {
  const canonical = JSON.stringify({
    title: input.title ?? null,
    description: input.description ?? null,
    price: input.price ?? null,
    walletAddress: input.walletAddress ?? null,
    externalUrl: input.externalUrl ?? null,
    fileContentHash: input.fileContentHash ?? null,
    filename: input.filename ?? null,
    mimeType: input.mimeType ?? null,
  });
  return createHash("sha256").update(canonical).digest("hex");
}

type MaybePromise<T> = T | Promise<T>;

export interface IdempotencyStore {
  get(key: string): MaybePromise<IdempotencyRecord | undefined>;
  /**
   * Atomically claims `key` if it is free (absent or expired) and stores
   * `value` for it. Returns undefined when this call won the reservation —
   * the caller owns it and should proceed. Returns the existing record when
   * someone else already holds a live reservation (#170): the caller must
   * not perform the effect, and instead replays or conflicts based on that
   * record's fingerprint.
   */
  reserve(key: string, value: IdempotencyRecord, ttlMs?: number): MaybePromise<IdempotencyRecord | undefined>;
  set(key: string, value: IdempotencyRecord, ttlMs?: number): MaybePromise<void>;
  delete(key: string): MaybePromise<void>;
  clear(): MaybePromise<void>;
}

function createInMemoryIdempotencyStore(): IdempotencyStore {
  const cache = createTtlCache<IdempotencyRecord>({
    defaultTtlMs: config.IDEMPOTENCY_TTL_MS,
    cacheName: "idempotency",
  });
  return {
    get: (key) => cache.get(key),
    set: (key, value, ttlMs) => cache.set(key, value, ttlMs),
    delete: (key) => cache.delete(key),
    clear: () => cache.clear(),
    reserve: (key, value, ttlMs) => {
      // Single-threaded JS: nothing can run between this get() (which also
      // evicts an expired entry) and the set() below, so this check-and-set
      // is atomic without any extra locking.
      const existing = cache.get(key);
      if (existing) return existing;
      cache.set(key, value, ttlMs);
      return undefined;
    },
  };
}

const defaultStore = createInMemoryIdempotencyStore();

/** Abandoned in-progress markers expire after twice the request timeout. */
export const IDEMPOTENCY_IN_PROGRESS_TTL_MS = config.REQUEST_TIMEOUT_MS * 2;

// Shared (Postgres-backed) store installed at boot so retries that land on a
// different replica see the original result (#71). When unset (tests, local
// scripts) the in-memory store above is used.
let sharedStore: IdempotencyStore | undefined;

export function useSharedIdempotencyStore(store: IdempotencyStore): void {
  sharedStore = store;
}

export function getIdempotencyStore(): IdempotencyStore {
  return sharedStore ?? defaultStore;
}
