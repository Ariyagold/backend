import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { IdempotencyRecord } from "../lib/idempotency.js";
import type { IdempotencyRow, IdempotencyRowStore } from "../lib/idempotencyPgStore.js";
import {
  startIdempotencyCleanupWorker,
  stopIdempotencyCleanupWorker,
  sweepExpiredIdempotency,
} from "./idempotencyCleanupWorker.js";

/** In-memory row store whose clock can be advanced to age records. */
function fakeRows(now: () => number): IdempotencyRowStore & { rows: Map<string, IdempotencyRow> } {
  const rows = new Map<string, IdempotencyRow>();
  return {
    rows,
    async select(key) {
      const row = rows.get(key);
      return row ? structuredClone(row) : undefined;
    },
    async insertIfAbsent(key, record, expiresAt) {
      if (rows.has(key)) return false;
      rows.set(key, { record: structuredClone(record), expiresAt });
      return true;
    },
    async upsert(key, record, expiresAt) {
      rows.set(key, { record: structuredClone(record), expiresAt });
    },
    async remove(key) {
      rows.delete(key);
    },
    async removeAll() {
      rows.clear();
    },
    async deleteExpired(batchSize) {
      const expired = [...rows.entries()]
        .filter(([, row]) => row.expiresAt.getTime() < now())
        .sort(([, a], [, b]) => a.expiresAt.getTime() - b.expiresAt.getTime())
        .slice(0, batchSize);
      for (const [key] of expired) rows.delete(key);
      return expired.length;
    },
  };
}

const inProgress = (fingerprint: string): IdempotencyRecord => ({ inProgress: true, fingerprint });
const completed = (fingerprint: string): IdempotencyRecord => ({
  inProgress: false,
  fingerprint,
  result: { status: 201, body: { id: fingerprint } },
});

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  stopIdempotencyCleanupWorker();
  vi.useRealTimers();
});

describe("sweepExpiredIdempotency (#173)", () => {
  it("removes abandoned expired rows but keeps live reservations and unexpired results", async () => {
    let t = 1_000;
    const rows = fakeRows(() => t);
    await rows.upsert("abandoned", inProgress("old"), new Date(t - 1));
    await rows.upsert("forgotten-result", completed("done"), new Date(t - 60_000));
    await rows.upsert("active-reservation", inProgress("live"), new Date(t + 60_000));
    await rows.upsert("unexpired-result", completed("live"), new Date(t + 60_000));

    const deleted = await sweepExpiredIdempotency((n) => rows.deleteExpired(n), {
      batchSize: 1,
      maxBatchesPerTick: 10,
    });

    expect(deleted).toBe(2);
    expect(await rows.select("abandoned")).toBeUndefined();
    expect(await rows.select("forgotten-result")).toBeUndefined();
    expect((await rows.select("active-reservation"))?.record).toEqual(inProgress("live"));
    expect((await rows.select("unexpired-result"))?.record).toEqual(completed("live"));
  });

  it("caps the work per tick at maxBatchesPerTick * batchSize", async () => {
    const deleteBatch = vi.fn().mockResolvedValue(3);

    const deleted = await sweepExpiredIdempotency(deleteBatch, { batchSize: 3, maxBatchesPerTick: 2 });

    expect(deleteBatch).toHaveBeenCalledTimes(2);
    expect(deleteBatch).toHaveBeenCalledWith(3);
    expect(deleted).toBe(6);
  });

  it("stops early once a batch is smaller than the limit", async () => {
    const deleteBatch = vi.fn().mockResolvedValueOnce(3).mockResolvedValueOnce(1);

    const deleted = await sweepExpiredIdempotency(deleteBatch, { batchSize: 3, maxBatchesPerTick: 10 });

    expect(deleteBatch).toHaveBeenCalledTimes(2);
    expect(deleted).toBe(4);
  });
});

describe("idempotencyCleanupWorker lifecycle", () => {
  it("sweeps immediately and on each interval, and stops cleanly", async () => {
    const deleteBatch = vi.fn().mockResolvedValue(0);
    startIdempotencyCleanupWorker(deleteBatch, { intervalMs: 1_000, batchSize: 5, maxBatchesPerTick: 2 });

    await vi.advanceTimersByTimeAsync(0);
    expect(deleteBatch).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1_000);
    expect(deleteBatch).toHaveBeenCalledTimes(2);

    stopIdempotencyCleanupWorker();
    await vi.advanceTimersByTimeAsync(3_000);
    expect(deleteBatch).toHaveBeenCalledTimes(2);
  });

  it("ignores a duplicate start instead of creating two timers", async () => {
    const first = vi.fn().mockResolvedValue(0);
    const second = vi.fn().mockResolvedValue(0);
    startIdempotencyCleanupWorker(first, { intervalMs: 1_000 });
    startIdempotencyCleanupWorker(second, { intervalMs: 1_000 });

    await vi.advanceTimersByTimeAsync(2_000);

    expect(first).toHaveBeenCalledTimes(3);
    expect(second).not.toHaveBeenCalled();
  });

  it("keeps ticking after a database error", async () => {
    const deleteBatch = vi.fn().mockRejectedValueOnce(new Error("db down")).mockResolvedValue(0);
    startIdempotencyCleanupWorker(deleteBatch, { intervalMs: 1_000 });

    await vi.advanceTimersByTimeAsync(0);
    expect(deleteBatch).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(deleteBatch).toHaveBeenCalledTimes(2);
  });
});
