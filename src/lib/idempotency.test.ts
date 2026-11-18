import { describe, it, expect, beforeEach, vi } from "vitest";

// idempotency.ts imports config; mock it so the test doesn't require a full env.
vi.mock("../config.js", () => ({ config: { IDEMPOTENCY_TTL_MS: 60_000 } }));

import { getIdempotencyStore, idempotencyCacheKey } from "./idempotency.js";

describe("idempotencyCacheKey", () => {
  it("scopes keys per publisher", () => {
    expect(idempotencyCacheKey("pub1", "abc")).toBe("pub1:abc");
    expect(idempotencyCacheKey("pub1", "abc")).not.toBe(idempotencyCacheKey("pub2", "abc"));
  });
});

describe("idempotency store", () => {
  beforeEach(() => getIdempotencyStore().clear());

  it("returns the original result on a repeat lookup", async () => {
    const store = getIdempotencyStore();
    const key = idempotencyCacheKey("pub1", "k1");

    // First request marks the key in progress...
    await store.set(key, { inProgress: true, fingerprint: "fp" });
    expect(await store.get(key)).toEqual({ inProgress: true, fingerprint: "fp" });

    // ...then records the committed result.
    const result = { status: 201, body: { id: "r1", title: "Doc" } };
    await store.set(key, { inProgress: false, fingerprint: "fp", result });

    // A retry sees the same stored result.
    expect(await store.get(key)).toEqual({ inProgress: false, fingerprint: "fp", result });
  });

  it("isolates identical keys across different publishers", async () => {
    const store = getIdempotencyStore();
    await store.set(idempotencyCacheKey("pubA", "same"), {
      inProgress: false,
      fingerprint: "fp",
      result: { status: 201, body: { id: "A" } },
    });

    expect(await store.get(idempotencyCacheKey("pubB", "same"))).toBeUndefined();
  });
});

// ── Concurrent-retry tests (#312) ──────────────────────────────────────────

describe("idempotency store – concurrent requests", () => {
  beforeEach(() => getIdempotencyStore().clear());

  /**
   * Simulates two concurrent in-flight requests sharing the same idempotency
   * key. Only the first caller should perform the effect; the second should
   * observe the in-progress marker and block/defer rather than racing to
   * create a duplicate.
   *
   * In practice the server uses the in-progress marker as a 409 signal.
   * This test verifies the store correctly represents that protocol.
   */
  it("concurrent same-key requests: first wins, second sees in-progress marker", async () => {
    const store = getIdempotencyStore();
    const key = idempotencyCacheKey("pub1", "concurrent-key");

    // ── Caller A starts first and claims the key ───────────────────────────
    expect(await store.get(key)).toBeUndefined();
    await store.set(key, { inProgress: true, fingerprint: "fp" });

    // ── Caller B arrives while A is still running ──────────────────────────
    const recordB = await store.get(key);
    expect(recordB).toEqual({ inProgress: true, fingerprint: "fp" });
    // Caller B should detect the in-progress marker and NOT write its own
    // entry (simulating the 409-conflict fast-path).
    const callerBPerformedEffect = recordB?.inProgress === false;
    expect(callerBPerformedEffect).toBe(false);

    // ── Caller A finishes and commits the result ───────────────────────────
    const committedResult = { status: 201, body: { id: "r1", title: "Doc" } };
    await store.set(key, { inProgress: false, fingerprint: "fp", result: committedResult });

    // ── Both callers now observe the same committed result ─────────────────
    const recordAfterA = await store.get(key);
    expect(recordAfterA).toEqual({ inProgress: false, fingerprint: "fp", result: committedResult });

    // Caller B polling/retrying also sees the committed result.
    const recordBRetry = await store.get(key);
    expect(recordBRetry).toEqual({ inProgress: false, fingerprint: "fp", result: committedResult });
  });

  it("concurrent same-key requests produce at most one committed result", async () => {
    const store = getIdempotencyStore();
    const key = idempotencyCacheKey("pub2", "race-key");

    let effectCount = 0;

    // Simulate two callers running concurrently as micro-tasks. They use
    // reserve() (#170) rather than a separate get()-then-set(): once get/set
    // are `await`-ed (as every real store, in-memory or shared, now is), a
    // manual check-then-set has a gap between the two awaits that two
    // concurrent callers can both slip through. reserve() closes that gap by
    // making the claim atomic.
    async function caller(result: { status: number; body: unknown }): Promise<boolean> {
      // Try to claim the key; back off if someone else already holds it
      // (simulate the 409 fast path).
      const existing = await store.reserve(key, { inProgress: true, fingerprint: "fp" });
      if (existing !== undefined) return false;

      // Simulate async work (publish effect).
      await Promise.resolve();
      effectCount++;

      await store.set(key, { inProgress: false, fingerprint: "fp", result });
      return true;
    }

    // Fire both callers without awaiting between them (true concurrent start).
    const [didA, didB] = await Promise.all([
      caller({ status: 201, body: { id: "A" } }),
      caller({ status: 201, body: { id: "B" } }),
    ]);

    // Exactly one caller should have performed the effect.
    expect(effectCount).toBe(1);
    // Exactly one caller should have committed.
    const committed = [didA, didB].filter(Boolean);
    expect(committed).toHaveLength(1);

    // The store should hold a single, consistent result.
    const record = await store.get(key);
    expect(record).toBeDefined();
    expect(record?.inProgress).toBe(false);
  });

  it("returns the committed result to all callers once in-progress resolves", async () => {
    const store = getIdempotencyStore();
    const key = idempotencyCacheKey("pub3", "resolve-key");
    const committed = { status: 201, body: { id: "final" } };

    await store.set(key, { inProgress: true, fingerprint: "fp" });
    await store.set(key, { inProgress: false, fingerprint: "fp", result: committed });

    // All subsequent reads return the same committed result.
    for (let i = 0; i < 5; i++) {
      expect(await store.get(key)).toEqual({ inProgress: false, fingerprint: "fp", result: committed });
    }
  });

  // ── Key reuse after completion (#312) ─────────────────────────────────────

  it("allows key reuse after the TTL expires (completed result evicted)", async () => {
    // Use an injectable clock so we can advance time deterministically.
    let now = 1_000_000;
    const { createTtlCache } = await import("./ttlCache.js");
    const shortStore = createTtlCache<import("./idempotency.js").IdempotencyRecord>({
      defaultTtlMs: 100,
      now: () => now,
    });

    const key = idempotencyCacheKey("pub4", "reuse-key");
    const firstResult = { status: 201, body: { id: "first" } };
    shortStore.set(key, { inProgress: false, fingerprint: "fp", result: firstResult });

    // Before expiry – same result returned.
    expect(shortStore.get(key)).toEqual({ inProgress: false, fingerprint: "fp", result: firstResult });

    // Advance past the TTL.
    now += 200;

    // After expiry – entry is evicted.
    expect(shortStore.get(key)).toBeUndefined();

    // A new request can now claim and commit a fresh result.
    shortStore.set(key, { inProgress: true, fingerprint: "fp2" });
    const secondResult = { status: 201, body: { id: "second" } };
    shortStore.set(key, { inProgress: false, fingerprint: "fp2", result: secondResult });

    expect(shortStore.get(key)).toEqual({ inProgress: false, fingerprint: "fp2", result: secondResult });
  });

  // ── Key reuse after failure (#312) ────────────────────────────────────────

  it("allows key reuse after a failed attempt is cleared", async () => {
    const store = getIdempotencyStore();
    const key = idempotencyCacheKey("pub5", "failure-key");

    // First attempt is in-progress.
    await store.set(key, { inProgress: true, fingerprint: "fp" });

    // Simulate failure: caller deletes the key so the next request can retry.
    await store.delete(key);
    expect(await store.get(key)).toBeUndefined();

    // A retry can now claim the key and commit a result.
    await store.set(key, { inProgress: true, fingerprint: "fp2" });
    const retryResult = { status: 201, body: { id: "retry-success" } };
    await store.set(key, { inProgress: false, fingerprint: "fp2", result: retryResult });

    expect(await store.get(key)).toEqual({ inProgress: false, fingerprint: "fp2", result: retryResult });
  });

  it("does not double-apply effects when a client retries after server commit", async () => {
    const store = getIdempotencyStore();
    const key = idempotencyCacheKey("pub6", "client-retry-key");
    const originalResult = { status: 201, body: { id: "original" } };

    // Server commits the result.
    await store.set(key, { inProgress: true, fingerprint: "fp" });
    await store.set(key, { inProgress: false, fingerprint: "fp", result: originalResult });

    // Client did not receive the response (network blip) and retries.
    const retryRecord = await store.get(key);
    // The server detects the committed record and returns the stored result
    // without applying the effect again.
    expect(retryRecord).toEqual({ inProgress: false, fingerprint: "fp", result: originalResult });
    expect((retryRecord as any)?.inProgress).toBe(false);
  });

  it("result consistency: concurrent readers see the same committed body", async () => {
    const store = getIdempotencyStore();
    const key = idempotencyCacheKey("pub7", "consistency-key");
    const committed = { status: 201, body: { id: "consistent", title: "Consistent Doc" } };

    await store.set(key, { inProgress: false, fingerprint: "fp", result: committed });

    const reads = await Promise.all(Array.from({ length: 10 }, () => store.get(key)));
    reads.forEach((r) => {
      expect(r).toEqual({ inProgress: false, fingerprint: "fp", result: committed });
    });
  });
});

// ── Fingerprint mismatch (#171) and atomic reservation (#170) ──────────────

describe("idempotency store – reserve()", () => {
  beforeEach(() => getIdempotencyStore().clear());

  it("reserve() returns undefined (and claims the key) when it is free", async () => {
    const store = getIdempotencyStore();
    const key = idempotencyCacheKey("pub8", "fresh-key");

    expect(await store.reserve(key, { inProgress: true, fingerprint: "fp" })).toBeUndefined();
    expect(await store.get(key)).toEqual({ inProgress: true, fingerprint: "fp" });
  });

  it("reserve() returns the existing record instead of claiming an already-held key", async () => {
    const store = getIdempotencyStore();
    const key = idempotencyCacheKey("pub9", "held-key");

    await store.set(key, { inProgress: true, fingerprint: "original" });

    const second = await store.reserve(key, { inProgress: true, fingerprint: "different" });
    expect(second).toEqual({ inProgress: true, fingerprint: "original" });
    // The second caller's attempt must not have overwritten the first's record.
    expect(await store.get(key)).toEqual({ inProgress: true, fingerprint: "original" });
  });

  it("surfaces a fingerprint mismatch so callers can reject it as a conflict", async () => {
    const store = getIdempotencyStore();
    const key = idempotencyCacheKey("pub10", "mismatch-key");

    await store.set(key, {
      inProgress: false,
      fingerprint: "original-request",
      result: { status: 201, body: { id: "r1" } },
    });

    const existing = await store.reserve(key, { inProgress: true, fingerprint: "different-request" });
    expect(existing?.fingerprint).toBe("original-request");
    expect(existing?.fingerprint).not.toBe("different-request");
  });
});
