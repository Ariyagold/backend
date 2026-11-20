import type { IdempotencyRecord, IdempotencyStore } from "./idempotency.js";

// Shared idempotency store (#71). Records live in the `idempotency_records`
// Postgres table (unique key, JSON record, expiry) so a retry that lands on a
// different replica sees the original result instead of creating a duplicate.
// The in-memory store in idempotency.ts remains the default (and is what most
// tests use).
//
// Expired rows are also removed by a background sweep (#173): get(key) alone
// only cleans up keys a client happens to retry, leaving abandoned keys behind.

export interface IdempotencyRow {
  record: IdempotencyRecord;
  expiresAt: Date;
}

// Thin persistence seam so the store logic can be tested against a shared fake.
export interface IdempotencyRowStore {
  select(key: string): Promise<IdempotencyRow | undefined>;
  /**
   * Atomically claims `key` if it is absent or its current row is expired
   * (compared using the database's own clock, not the app's), writing
   * `record`/`expiresAt` for it. Returns true when this call claimed the
   * row; false when a live row already exists under another owner (#170).
   */
  insertIfAbsent(key: string, record: IdempotencyRecord, expiresAt: Date): Promise<boolean>;
  upsert(key: string, record: IdempotencyRecord, expiresAt: Date): Promise<void>;
  remove(key: string): Promise<void>;
  removeAll(): Promise<void>;
  /**
   * Deletes at most `batchSize` rows already expired according to the
   * database's clock and returns how many were deleted. Rows that are still
   * live (or have no expiry yet) are never touched, so active reservations and
   * unexpired completed responses survive the sweep (#173).
   */
  deleteExpired(batchSize: number): Promise<number>;
}

// Minimal shape of the postgres.js tagged-template client.
export type PgSql = (strings: TemplateStringsArray, ...values: any[]) => Promise<any[]>;

export function createPostgresRowStore(sql: PgSql): IdempotencyRowStore {
  return {
    async select(key) {
      const rows = await sql`SELECT record, expires_at FROM idempotency_records WHERE key = ${key}`;
      const row = rows[0];
      if (!row) return undefined;
      const record =
        typeof row.record === "string" ? (JSON.parse(row.record) as IdempotencyRecord) : row.record;
      return { record, expiresAt: new Date(row.expires_at) };
    },
    async insertIfAbsent(key, record, expiresAt) {
      // The WHERE clause on the DO UPDATE only fires the update — and so
      // only returns a row — when the existing reservation has already
      // expired by the database's clock. A live reservation under another
      // caller leaves this a no-op: no row is returned and no column is
      // touched, so that caller's data is untouched (#170).
      const rows = await sql`
        INSERT INTO idempotency_records (key, record, expires_at)
        VALUES (${key}, ${JSON.stringify(record)}::jsonb, ${expiresAt})
        ON CONFLICT (key) DO UPDATE
          SET record = EXCLUDED.record, expires_at = EXCLUDED.expires_at
          WHERE idempotency_records.expires_at < now()
        RETURNING key`;
      return rows.length > 0;
    },
    async upsert(key, record, expiresAt) {
      await sql`
        INSERT INTO idempotency_records (key, record, expires_at)
        VALUES (${key}, ${JSON.stringify(record)}::jsonb, ${expiresAt})
        ON CONFLICT (key) DO UPDATE SET record = EXCLUDED.record, expires_at = EXCLUDED.expires_at`;
    },
    async remove(key) {
      await sql`DELETE FROM idempotency_records WHERE key = ${key}`;
    },
    async removeAll() {
      await sql`DELETE FROM idempotency_records`;
    },
    async deleteExpired(batchSize) {
      // Postgres has no DELETE ... LIMIT, so the bounded set of keys is picked
      // in a subquery. `expires_at < now()` uses the database's own clock (as
      // insertIfAbsent does) and the idx_idempotency_records_expires_at index;
      // SKIP LOCKED keeps the sweep from blocking a request that is writing one
      // of the candidate rows. Only rows past their expiry are returned, so
      // live reservations and unexpired results stay intact (#173).
      const rows = await sql`
        DELETE FROM idempotency_records
        WHERE key IN (
          SELECT key FROM idempotency_records
          WHERE expires_at < now()
          ORDER BY expires_at
          LIMIT ${batchSize}
          FOR UPDATE SKIP LOCKED
        )
        RETURNING key`;
      return rows.length;
    },
  };
}

export function createSharedIdempotencyStore(
  rows: IdempotencyRowStore,
  options: { defaultTtlMs: number; now?: () => number },
): IdempotencyStore {
  const now = options.now ?? Date.now;
  return {
    async get(key) {
      const row = await rows.select(key);
      if (!row) return undefined;
      if (now() >= row.expiresAt.getTime()) {
        await rows.remove(key);
        return undefined;
      }
      return row.record;
    },
    async set(key, value, ttlMs) {
      await rows.upsert(key, value, new Date(now() + (ttlMs ?? options.defaultTtlMs)));
    },
    async reserve(key, value, ttlMs) {
      const expiresAt = new Date(now() + (ttlMs ?? options.defaultTtlMs));
      const claimed = await rows.insertIfAbsent(key, value, expiresAt);
      if (claimed) return undefined;
      // Someone else holds a live reservation; hand its record back so the
      // caller can compare fingerprints instead of racing to overwrite it.
      const existing = await rows.select(key);
      return existing?.record;
    },
    delete: (key) => rows.remove(key),
    clear: () => rows.removeAll(),
  };
}
