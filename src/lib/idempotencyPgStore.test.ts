import { describe, it, expect } from "vitest";
import {
  createPostgresRowStore,
  createSharedIdempotencyStore,
  type IdempotencyRow,
  type IdempotencyRowStore,
  type PgSql,
} from "./idempotencyPgStore.js";

// A fake "database" shared by several store instances (simulating replicas).
// `now` mirrors the database's own clock, which `insertIfAbsent` compares
// against — independent of the app-side clock passed to the store (#170).
function fakeDatabase(now: () => number = Date.now): IdempotencyRowStore {
  const table = new Map<string, IdempotencyRow>();
  return {
    async select(key) {
      const row = table.get(key);
      return row ? structuredClone(row) : undefined;
    },
    async insertIfAbsent(key, record, expiresAt) {
      const existing = table.get(key);
      if (existing && existing.expiresAt.getTime() >= now()) return false;
      table.set(key, { record: structuredClone(record), expiresAt });
      return true;
    },
    async upsert(key, record, expiresAt) {
      table.set(key, { record: structuredClone(record), expiresAt });
    },
    async remove(key) {
      table.delete(key);
    },
    async removeAll() {
      table.clear();
    },
    async deleteExpired(batchSize) {
      const expired = [...table.entries()]
        .filter(([, row]) => row.expiresAt.getTime() < now())
        .sort(([, a], [, b]) => a.expiresAt.getTime() - b.expiresAt.getTime())
        .slice(0, batchSize);
      for (const [key] of expired) table.delete(key);
      return expired.length;
    },
  };
}

describe("shared idempotency store", () => {
  it("returns the original result on retry from another instance", async () => {
    const db = fakeDatabase();
    const a = createSharedIdempotencyStore(db, { defaultTtlMs: 60_000 });
    const b = createSharedIdempotencyStore(db, { defaultTtlMs: 60_000 });
    const result = { status: 201, body: { id: "r1" } };

    await a.set("pub:k", { inProgress: true, fingerprint: "fp" });
    expect(await b.get("pub:k")).toEqual({ inProgress: true, fingerprint: "fp" });
    await a.set("pub:k", { inProgress: false, fingerprint: "fp", result });
    expect(await b.get("pub:k")).toEqual({ inProgress: false, fingerprint: "fp", result });
  });

  it("expires records and supports delete", async () => {
    let t = 1_000;
    const db = fakeDatabase(() => t);
    const s = createSharedIdempotencyStore(db, { defaultTtlMs: 100, now: () => t });
    await s.set("k", { inProgress: true, fingerprint: "fp" });
    t += 200;
    expect(await s.get("k")).toBeUndefined();
    await s.set("k2", { inProgress: true, fingerprint: "fp" });
    await s.delete("k2");
    expect(await s.get("k2")).toBeUndefined();
  });

  // ── Atomic reservation (#170) ───────────────────────────────────────────

  it("reserve() lets only one of two simultaneous callers claim a fresh key", async () => {
    const db = fakeDatabase();
    const a = createSharedIdempotencyStore(db, { defaultTtlMs: 60_000 });
    const b = createSharedIdempotencyStore(db, { defaultTtlMs: 60_000 });

    const [resultA, resultB] = await Promise.all([
      a.reserve("pub:k", { inProgress: true, fingerprint: "fp" }),
      b.reserve("pub:k", { inProgress: true, fingerprint: "fp" }),
    ]);

    // Exactly one call won (got undefined back); the other observed the
    // winner's record instead of also claiming the key.
    const winners = [resultA, resultB].filter((r) => r === undefined);
    expect(winners).toHaveLength(1);
    const loserResult = resultA === undefined ? resultB : resultA;
    expect(loserResult).toEqual({ inProgress: true, fingerprint: "fp" });
  });

  it("reserve() refuses a second claim while the first reservation is live", async () => {
    const db = fakeDatabase();
    const s = createSharedIdempotencyStore(db, { defaultTtlMs: 60_000 });

    expect(await s.reserve("k", { inProgress: true, fingerprint: "fp" })).toBeUndefined();
    expect(await s.reserve("k", { inProgress: true, fingerprint: "other" })).toEqual({
      inProgress: true,
      fingerprint: "fp",
    });
  });

  it("reserve() lets a new caller claim the key once the prior reservation expired", async () => {
    let t = 1_000;
    const db = fakeDatabase(() => t);
    const s = createSharedIdempotencyStore(db, { defaultTtlMs: 100, now: () => t });

    expect(await s.reserve("k", { inProgress: true, fingerprint: "fp" })).toBeUndefined();
    t += 200;
    expect(await s.reserve("k", { inProgress: true, fingerprint: "fp2" })).toBeUndefined();
  });
});

describe("Postgres row store expiry sweep (#173)", () => {
  it("deletes expired rows in one bounded statement using the database clock", async () => {
    const queries: Array<{ text: string; values: unknown[] }> = [];
    const sql: PgSql = async (strings, ...values) => {
      queries.push({ text: strings.join("?"), values });
      return [{ key: "expired-1" }, { key: "expired-2" }];
    };

    const deleted = await createPostgresRowStore(sql).deleteExpired(25);

    expect(deleted).toBe(2);
    expect(queries).toHaveLength(1);
    const [query] = queries;
    expect(query?.values).toEqual([25]);
    expect(query?.text).toContain("DELETE FROM idempotency_records");
    expect(query?.text).toContain("WHERE expires_at < now()");
    expect(query?.text).toContain("ORDER BY expires_at");
    expect(query?.text).toContain("LIMIT ?");
    expect(query?.text).toContain("FOR UPDATE SKIP LOCKED");
    expect(query?.text).toContain("RETURNING key");
  });
});
