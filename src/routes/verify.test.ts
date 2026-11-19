import { beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";
import { hashFileResource, hashLinkResource } from "../utils/crypto.js";

const h = vi.hoisted(() => ({
  checkOriginality: vi.fn(),
  resourceRows: [] as Array<Record<string, unknown>>,
  paywallHits: vi.fn(),
  insert: vi.fn(),
  update: vi.fn(),
  setValues: vi.fn(),
  // Aggregate results returned by the mocked db for /agent/status.
  aggregateRow: { totalVerifications: 0, verified: 0, rejected: 0, avgConfidence: 0 } as Record<
    string,
    unknown
  >,
  // Rows returned by the resource lookup (where -> limit) path.
  resourceRows: [] as Array<Record<string, unknown>>,
  // Rows returned by the guarded resource update (where -> returning).
  updateReturningRows: [] as Array<Record<string, unknown>> | null,
  // Values passed to the verification-row insert (first insert call).
  verificationInsertValues: [] as Array<Record<string, unknown>>,
  // Daily spend budget gate (#186).
  spendRows: [] as Array<Record<string, unknown>>,
  budgetReject: null as null | { reason: string; limitUsd: number; spentUsd: number },
  // Settled verification-fee sum returned by the earnings query (#99).
  earnedTotal: null as string | null,
  recentRows: [] as Array<Record<string, unknown>>,
  // Records how many rows each select path was asked to return.
  selectCalls: [] as Array<{ kind: "aggregate" | "recent" | "other"; limit?: number }>,
  enqueueWebhookEvent: vi.fn(),
}));

vi.mock("../config.js", () => ({
  config: {
    BASE_URL: "http://localhost:4021",
    PAY_TO: "GTEST123456789",
    NETWORK: "testnet",
    VERIFICATION_PRICE: "0.10",
    OPENROUTER_MODEL: "test-model",
  },
}));

vi.mock("../services/verificationService.js", () => ({
  checkOriginality: h.checkOriginality,
}));

vi.mock("../services/webhookService.js", () => ({
  emitToPublisher: vi.fn(),
  enqueueWebhookEvent: h.enqueueWebhookEvent,
}));

vi.mock("../db/client.js", () => {
  // A select() chain that supports the resource lookup (where -> limit) and
  // the /agent/status aggregate, earnings and recent-activity queries.
  const isAggregate = (fields: Record<string, unknown> | undefined) =>
    !!fields && "totalVerifications" in fields;
  const isEarnings = (fields: Record<string, unknown> | undefined) =>
    !!fields && "total" in fields && !("totalVerifications" in fields);
  const makeChain = (fields: Record<string, unknown> | undefined) => {
    const chain: any = {
      from: () => chain,
      where: () => chain,
      groupBy: () => chain,
      orderBy: () => chain,
      for: () => chain,
      limit: (n: number) => {
        // Distinguish the resource lookup from the recent-activity query by
        // whether the caller selected aggregate fields.
        if (isAggregate(fields)) {
          h.selectCalls.push({ kind: "aggregate", limit: n });
          return Promise.resolve([h.aggregateRow]);
        }
        if (n === 10) {
          h.selectCalls.push({ kind: "recent", limit: n });
          return Promise.resolve(h.recentRows);
        }
        h.selectCalls.push({ kind: "other", limit: n });
        return Promise.resolve(h.resourceRows);
      },
      // Aggregate queries may resolve directly (no limit) or via groupBy.
      then: (resolve: (value: unknown) => unknown, reject: (err: unknown) => unknown) => {
        if (isAggregate(fields)) {
          h.selectCalls.push({ kind: "aggregate" });
          return Promise.resolve([h.aggregateRow]).then(resolve, reject);
        }
        if (isEarnings(fields)) {
          h.selectCalls.push({ kind: "aggregate" });
          return Promise.resolve([{ total: h.earnedTotal }]).then(resolve, reject);
        }
        return Promise.resolve(h.resourceRows).then(resolve, reject);
      },
    };
    return chain;
  };

  const db: any = {
    select: vi.fn((fields?: Record<string, unknown>) => makeChain(fields)),
    insert: (...args: unknown[]) => h.insert(...args),
    update: (...args: unknown[]) => h.update(...args),
  };
  // The route wraps its writes in db.transaction() (#182). This fake doesn't
  // model real atomicity — it just runs the callback with the same
  // insert/update spies, which is enough for these tests' assertions.
  db.transaction = (cb: (tx: typeof db) => Promise<unknown>) => cb(db);

  return { db };
});

vi.mock("../db/schema.js", () => ({
  resources: {},
  verifications: {},
  payments: {},
}));

// The daily spend budget gate (#186) is mocked so tests can simulate
// exhaustion and concurrency without real persistence.
vi.mock("../services/spendBudgetService.js", () => ({
  reserveVerificationSpend: vi.fn(async () => {
    if (h.budgetReject) {
      const { AppError } = await import("../lib/errors.js");
      throw new AppError("BUDGET_EXCEEDED", h.budgetReject.reason, {
        retryable: false,
        ...h.budgetReject,
      });
    }
    return { reservationId: "resv-1" };
  }),
  settleVerificationSpend: vi.fn(async () => undefined),
  releaseVerificationSpend: vi.fn(async () => undefined),
}));

vi.mock("../lib/x402.js", () => ({
  network: "testnet",
  sharedX402ResourceServer: {},
}));

vi.mock("@x402/express", () => ({
  paymentMiddleware: () => (_req: unknown, _res: unknown, next: () => void) => {
    h.paywallHits();
    next();
  },
}));

// Stand-in for apiKeyAuth: maps a known key to a publisher, rejects anything else.
vi.mock("../middleware/apiKeyAuth.js", async () => {
  const { AppError } = await import("../lib/errors.js");
  const publishers: Record<string, { id: string }> = {
    "key-pub-1": { id: "pub-1" },
    "key-pub-2": { id: "pub-2" },
  };
  return {
    apiKeyAuth: (req: any, _res: unknown, next: (err?: unknown) => void) => {
      const key = req.headers["x-api-key"];
      if (typeof key !== "string" || !publishers[key]) {
        next(new AppError("UNAUTHORIZED", "Missing x-api-key header"));
        return;
      }
      req.publisher = publishers[key];
      next();
    },
  };
});

vi.mock("../middleware/rateLimiters.js", () => ({
  verifyIpRateLimit: (_req: unknown, _res: unknown, next: () => void) => next(),
  verifyWalletRateLimit: (_req: unknown, _res: unknown, next: () => void) => next(),
}));

vi.mock("../middleware/validate.js", () => ({
  validate: () => (_req: unknown, _res: unknown, next: () => void) => next(),
}));

import verifyRouter from "./verify.js";
import { errorHandler } from "../middleware/errorHandler.js";

function createTestApp() {
  const app = express();
  app.use(express.json());
  app.use(verifyRouter);
  app.use(errorHandler);
  return app;
}

const mockUsage = {
  promptTokens: 10,
  completionTokens: 5,
  totalTokens: 15,
  estimatedCostUsd: 0.001,
};

const DOC_TEXT = "A comprehensive dataset for machine learning";
const LINK_URL = "https://example.com/dataset";

function fileRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "res-1",
    publisherId: "pub-1",
    title: "Doc",
    resourceType: "file",
    contentHash: hashFileResource(Buffer.from(DOC_TEXT, "utf8"), "Doc"),
    adminDelistedAt: null,
    ...overrides,
  };
}

function linkRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "res-link",
    publisherId: "pub-1",
    title: "Link",
    resourceType: "link",
    contentHash: hashLinkResource(LINK_URL, "Link"),
    adminDelistedAt: null,
    ...overrides,
  };
}

function approved(confidence = 0.95) {
  return {
    isOriginal: true,
    confidence,
    flags: ["Genuine resource"],
    usage: mockUsage,
    deterministicPassed: true,
  };
}

function rejected() {
  return {
    isOriginal: false,
    confidence: 0.2,
    flags: ["Low effort"],
    usage: mockUsage,
    deterministicPassed: true,
  };
}

function expectNothingChanged() {
  expect(h.checkOriginality).not.toHaveBeenCalled();
  expect(h.insert).not.toHaveBeenCalled();
  expect(h.update).not.toHaveBeenCalled();
}

describe("POST /verify-content — AI content verification endpoint", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.resourceRows = [];
    h.updateReturningRows = null;
    h.verificationInsertValues = [];
    h.budgetReject = null;
    h.checkOriginality.mockReset();
    h.insert.mockImplementation(() => ({
      values: vi.fn((values: Record<string, unknown>) => {
        // Record the verification row's values (the first insert) so tests can
        // assert on persisted model/prompt metadata (#185).
        if (values && "isOriginal" in values) {
          h.verificationInsertValues.push(values);
        }
        return {
          returning: vi.fn(() => Promise.resolve([{ id: "v1" }])),
        };
      }),
    }));
    h.update.mockImplementation(() => ({
      set: vi.fn((values: unknown) => {
        h.setValues(values);
        return {
          where: vi.fn(() => ({
            returning: vi.fn(() =>
              Promise.resolve(
                h.updateReturningRows ?? [{ publisherId: "pub-1", title: "Doc" }],
              ),
            ),
          })),
        };
      }),
    }));
  });

  describe("without resourceId (anonymous paid check, unchanged)", () => {
    it("returns verification result for approved content", async () => {
      h.checkOriginality.mockResolvedValue(approved());

      const res = await request(createTestApp())
        .post("/verify-content")
        .send({ content: DOC_TEXT });

      expect(res.status).toBe(200);
      expect(res.body).toEqual({
        isOriginal: true,
        confidence: 0.95,
        flags: ["Genuine resource"],
        usage: mockUsage,
        deterministicPassed: true,
      });
      expect(h.checkOriginality).toHaveBeenCalledWith(DOC_TEXT, "text", expect.objectContaining({ signal: expect.anything() }));
    });

    it("returns verification result for rejected content", async () => {
      h.checkOriginality.mockResolvedValue({
        isOriginal: false,
        confidence: 0.15,
        flags: ["Content appears to be spam or gibberish"],
        usage: mockUsage,
      });

      const res = await request(createTestApp()).post("/verify-content").send({ content: "test123 asdf" });

      expect(res.status).toBe(200);
      expect(res.body.isOriginal).toBe(false);
      expect(res.body.confidence).toBe(0.15);
    });

    it("does not touch resources or verifications rows", async () => {
      h.checkOriginality.mockResolvedValue(approved());

      const res = await request(createTestApp()).post("/verify-content").send({ content: DOC_TEXT });

      expect(res.status).toBe(200);
      expect(h.insert).not.toHaveBeenCalled();
      expect(h.update).not.toHaveBeenCalled();
    });

    it("returns a retryable 503 on provider failure and persists nothing (#187)", async () => {
      h.resourceRows = [fileRow()];
      h.checkOriginality.mockRejectedValue(
        Object.assign(new Error("empty"), { name: "VerificationProviderError", reason: "empty_response" }),
      );

      const res = await request(createTestApp())
        .post("/verify-content")
        .set("x-api-key", "key-pub-1")
        .send({ content: DOC_TEXT, resourceId: "res-1" });

      expect(res.status).toBe(503);
      expect(res.body.details).toMatchObject({ retryable: true });
      expect(h.insert).not.toHaveBeenCalled();
      expect(h.update).not.toHaveBeenCalled();
    });
  });

  describe("with resourceId", () => {
    it("requires an API key and does not run the AI check without one", async () => {
      h.resourceRows = [fileRow()];

      const res = await request(createTestApp())
        .post("/verify-content")
        .send({ content: DOC_TEXT, resourceId: "res-1" });

      expect(res.status).toBe(401);
      expectNothingChanged();
      expect(h.paywallHits).not.toHaveBeenCalled();
    });

    it("lets the owner verify their own resource and lists it when approved", async () => {
      h.resourceRows = [fileRow()];
      h.checkOriginality.mockResolvedValue(approved(0.88));

      const res = await request(createTestApp())
        .post("/verify-content")
        .set("x-api-key", "key-pub-1")
        .send({ content: DOC_TEXT, resourceId: "res-1" });

      expect(res.status).toBe(200);
      expect(res.body.isOriginal).toBe(true);
      // One verification row plus its fee payment row (#99).
      expect(h.insert).toHaveBeenCalledTimes(2);
      expect(h.setValues).toHaveBeenCalledWith({
        verificationStatus: "verified",
        verificationId: "v1",
        listed: true,
      });
    });

    it("does not list the resource when the deterministic injection check fails (#96)", async () => {
      h.resourceRows = [fileRow()];
      // Simulate the model being fooled by injected instructions.
      h.checkOriginality.mockResolvedValue({ ...approved(0.99), deterministicPassed: false });

      const res = await request(createTestApp())
        .post("/verify-content")
        .set("x-api-key", "key-pub-1")
        .send({ content: DOC_TEXT, resourceId: "res-1" });

      expect(res.status).toBe(200);
      expect(h.setValues).toHaveBeenCalledWith({
        verificationStatus: "rejected",
        verificationId: "v1",
        listed: false,
      });
    });

    it("records a rejection for the owner when the content is not original", async () => {
      h.resourceRows = [fileRow()];
      h.checkOriginality.mockResolvedValue(rejected());

      const res = await request(createTestApp())
        .post("/verify-content")
        .set("x-api-key", "key-pub-1")
        .send({ content: DOC_TEXT, resourceId: "res-1" });

      expect(res.status).toBe(200);
      expect(h.setValues).toHaveBeenCalledWith({
        verificationStatus: "rejected",
        verificationId: "v1",
        listed: false,
      });
    });

    it("rejects a non-owner with 403 before payment, and changes nothing", async () => {
      h.resourceRows = [fileRow()];

      const res = await request(createTestApp())
        .post("/verify-content")
        .set("x-api-key", "key-pub-2")
        .send({ content: DOC_TEXT, resourceId: "res-1" });

      expect(res.status).toBe(403);
      expect(res.body.error.message ?? res.body.error).toMatch(/do not own/);
      expectNothingChanged();
      expect(h.paywallHits).not.toHaveBeenCalled();
    });

    it("returns 404 for an unknown resource and changes nothing", async () => {
      h.resourceRows = [];

      const res = await request(createTestApp())
        .post("/verify-content")
        .set("x-api-key", "key-pub-1")
        .send({ content: DOC_TEXT, resourceId: "missing" });

      expect(res.status).toBe(404);
      expectNothingChanged();
    });

    it("blocks relisting an admin-delisted resource, even for its owner", async () => {
      h.resourceRows = [fileRow({ adminDelistedAt: new Date("2026-01-01T00:00:00Z") })];

      const res = await request(createTestApp())
        .post("/verify-content")
        .set("x-api-key", "key-pub-1")
        .send({ content: DOC_TEXT, resourceId: "res-1" });

      expect(res.status).toBe(403);
      expect(res.body.error.message ?? res.body.error).toMatch(/administrator/);
      expectNothingChanged();
    });

    it("rejects content whose hash does not match the stored content with 409", async () => {
      h.resourceRows = [fileRow()];

      const res = await request(createTestApp())
        .post("/verify-content")
        .set("x-api-key", "key-pub-1")
        .send({ content: "unrelated original text", resourceId: "res-1" });

      expect(res.status).toBe(409);
      expectNothingChanged();
      expect(h.paywallHits).not.toHaveBeenCalled();
    });

    it("rejects with 409 when the resource has no stored content_hash", async () => {
      h.resourceRows = [fileRow({ contentHash: null })];

      const res = await request(createTestApp())
        .post("/verify-content")
        .set("x-api-key", "key-pub-1")
        .send({ content: DOC_TEXT, resourceId: "res-1" });

      expect(res.status).toBe(409);
      expectNothingChanged();
    });

    it("binds link resources to their URL", async () => {
      h.resourceRows = [linkRow()];
      h.checkOriginality.mockResolvedValue(approved());

      const res = await request(createTestApp())
        .post("/verify-content")
        .set("x-api-key", "key-pub-1")
        .send({ content: LINK_URL, resourceId: "res-link" });

      expect(res.status).toBe(200);
      expect(h.setValues).toHaveBeenCalledWith(expect.objectContaining({ listed: true }));
      // The review input for a link is its URL, typed as "link" (#189).
      expect(h.checkOriginality).toHaveBeenCalledWith(LINK_URL, "link", expect.anything());
    });

    it("reviews file content typed as \"file\" and holds low-confidence results for review (#188, #189)", async () => {
      h.resourceRows = [fileRow()];
      h.checkOriginality.mockResolvedValue({ ...rejected(), needsReview: true });

      const res = await request(createTestApp())
        .post("/verify-content")
        .set("x-api-key", "key-pub-1")
        .send({ content: DOC_TEXT, resourceId: "res-1" });

      expect(res.status).toBe(200);
      expect(h.checkOriginality).toHaveBeenCalledWith(DOC_TEXT, "file", expect.anything());
      expect(h.setValues).toHaveBeenCalledWith(
        expect.objectContaining({ verificationStatus: "review_required", listed: false }),
      );
    });

    it("rejects a link resource when the content is not its URL", async () => {
      h.resourceRows = [linkRow()];

      const res = await request(createTestApp())
        .post("/verify-content")
        .set("x-api-key", "key-pub-1")
        .send({ content: "https://attacker.example/other", resourceId: "res-link" });

      expect(res.status).toBe(409);
      expectNothingChanged();
    });

    // ── Generation guard (#183) ──────────────────────────────────────────

    it("does not overwrite a newer verdict when an older check finishes last (#183)", async () => {
      h.resourceRows = [fileRow()];
      h.checkOriginality.mockResolvedValue(approved());
      // The guarded update matches no row: a newer verification generation
      // has already claimed the resource.
      h.updateReturningRows = [];

      const res = await request(createTestApp())
        .post("/verify-content")
        .set("x-api-key", "key-pub-1")
        .send({ content: DOC_TEXT, resourceId: "res-1" });

      // The stale result must not be reported as the current verdict, and the
      // resource row must not be replaced by the older check.
      expect(res.status).not.toBe(200);
      expect(h.setValues).not.toHaveBeenCalledWith(
        expect.objectContaining({ verificationStatus: "verified" }),
      );
    });

    it("applies the verdict when the generation guard still matches (#183)", async () => {
      h.resourceRows = [fileRow()];
      h.checkOriginality.mockResolvedValue(approved());
      h.updateReturningRows = [{ publisherId: "pub-1", title: "Doc" }];

      const res = await request(createTestApp())
        .post("/verify-content")
        .set("x-api-key", "key-pub-1")
        .send({ content: DOC_TEXT, resourceId: "res-1" });

      expect(res.status).toBe(200);
      expect(h.setValues).toHaveBeenCalledWith(
        expect.objectContaining({ verificationStatus: "verified", verificationId: "v1" }),
      );
    });

    // ── Model / prompt version provenance (#185) ─────────────────────────

    it("persists the model identifier and prompt version on new verification rows (#185)", async () => {
      h.resourceRows = [fileRow()];
      h.checkOriginality.mockResolvedValue(approved());

      const res = await request(createTestApp())
        .post("/verify-content")
        .set("x-api-key", "key-pub-1")
        .send({ content: DOC_TEXT, resourceId: "res-1" });

      expect(res.status).toBe(200);
      expect(h.verificationInsertValues).toHaveLength(1);
      expect(h.verificationInsertValues[0]).toMatchObject({
        model: "test-model",
        promptVersion: expect.any(String),
      });
      expect((h.verificationInsertValues[0].promptVersion as string).length).toBeGreaterThan(0);
    });

    // ── Daily spend budget gate (#186) ───────────────────────────────────

    it("rejects with 429 when the daily spend budget is exhausted, without charging (#186)", async () => {
      h.resourceRows = [fileRow()];
      h.budgetReject = {
        reason: "Daily verification spend limit reached",
        limitUsd: 5,
        spentUsd: 5,
      };

      const res = await request(createTestApp())
        .post("/verify-content")
        .set("x-api-key", "key-pub-1")
        .send({ content: DOC_TEXT, resourceId: "res-1" });

      expect(res.status).toBe(429);
      expect(h.checkOriginality).not.toHaveBeenCalled();
      expect(h.insert).not.toHaveBeenCalled();
      expect(h.update).not.toHaveBeenCalled();
    });

    it("never exceeds the budget under concurrent requests (#186)", async () => {
      const { reserveVerificationSpend } = await import("../services/spendBudgetService.js");
      const limitUsd = 0.1;
      let reserved = 0;
      const costPerCheck = 0.05;
      // Atomic reservation: only succeeds while the budget has room.
      vi.mocked(reserveVerificationSpend).mockImplementation(async () => {
        if (reserved + costPerCheck > limitUsd) {
          const { AppError } = await import("../lib/errors.js");
          throw new AppError("BUDGET_EXCEEDED", "Daily verification spend limit reached", {
            retryable: false,
          });
        }
        reserved += costPerCheck;
        return { reservationId: `resv-${reserved}` };
      });
      h.resourceRows = [fileRow()];
      h.checkOriginality.mockResolvedValue(approved());

      const app = createTestApp();
      const responses = await Promise.all(
        Array.from({ length: 5 }, () =>
          request(app)
            .post("/verify-content")
            .set("x-api-key", "key-pub-1")
            .send({ content: DOC_TEXT, resourceId: "res-1" }),
        ),
      );

      const accepted = responses.filter((r) => r.status === 200).length;
      const rejected = responses.filter((r) => r.status === 429).length;
      expect(accepted).toBe(2);
      expect(rejected).toBe(3);
      expect(reserved).toBeLessThanOrEqual(limitUsd);
      expect(h.checkOriginality).toHaveBeenCalledTimes(accepted);
    });

    // ── Transactional write (#182) ────────────────────────────────────────

    it("surfaces a mid-transaction failure as an error instead of partially completing", async () => {
      h.resourceRows = [fileRow()];
      h.checkOriginality.mockResolvedValue(approved());
      // The resource-status update is the last write inside the transaction;
      // make it fail to simulate a mid-sequence failure.
      h.update.mockImplementation(() => ({
        set: vi.fn(() => ({
          where: vi.fn(() => ({
            returning: vi.fn(() => Promise.reject(new Error("resource update boom"))),
          })),
        })),
      }));

      const res = await request(createTestApp())
        .post("/verify-content")
        .set("x-api-key", "key-pub-1")
        .send({ content: DOC_TEXT, resourceId: "res-1" });

      // The failure propagates out of db.transaction() as an error response —
      // the handler never reaches the code after it (settlement recording,
      // the "resource.listed" webhook) that would otherwise make the
      // workflow look complete despite the failed write.
      expect(res.status).toBe(500);
      expect(h.enqueueWebhookEvent).not.toHaveBeenCalled();
    });
  });
});

describe("GET /agent/status — public agent stats endpoint", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.aggregateRow = { totalVerifications: 0, verified: 0, rejected: 0, avgConfidence: 0 };
    h.earnedTotal = null;
    h.recentRows = [];
    h.selectCalls = [];
  });

  it("returns agent status with correct shape", async () => {
    const res = await request(createTestApp()).get("/agent/status");

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty("agent");
    expect(res.body).toHaveProperty("stats");
    expect(res.body).toHaveProperty("recentActivity");

    expect(res.body.agent).toMatchObject({
      name: "SynapsVault Verification Agent",
      walletAddress: "GTEST123456789",
      network: "testnet",
      endpoint: "http://localhost:4021/verify-content",
      pricePerVerification: "0.10",
      currency: "USDC",
      status: "active",
    });

    expect(res.body.stats).toMatchObject({
      totalVerifications: expect.any(Number),
      verified: expect.any(Number),
      rejected: expect.any(Number),
      totalEarned: expect.any(String),
      avgConfidence: expect.any(String),
    });

    expect(Array.isArray(res.body.recentActivity)).toBe(true);
  });

  it("returns stats with zero values when no verifications exist", async () => {
    const res = await request(createTestApp()).get("/agent/status");

    expect(res.status).toBe(200);
    expect(res.body.stats.totalVerifications).toBe(0);
    expect(res.body.stats.verified).toBe(0);
    expect(res.body.stats.rejected).toBe(0);
    expect(res.body.stats.totalEarned).toBe("0.0000");
    expect(res.body.stats.avgConfidence).toBe("0.00");
  });

  it("returns recent activity array with correct structure", async () => {
    const res = await request(createTestApp()).get("/agent/status");

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.recentActivity)).toBe(true);
  });

  it("computes totals from SQL aggregates and matches the old in-memory values", async () => {
    // Old implementation summed these rows in memory.
    const rows = [
      { isOriginal: true, confidence: 0.9, amountPaid: "0.10" },
      { isOriginal: true, confidence: 0.8, amountPaid: "0.10" },
      { isOriginal: false, confidence: 0.2, amountPaid: "0.10" },
    ];
    const expectedTotal = rows.length;
    const expectedVerified = rows.filter((r) => r.isOriginal).length;
    const expectedRejected = rows.filter((r) => !r.isOriginal).length;
    const expectedEarned = rows.reduce((sum, r) => sum + Number(r.amountPaid), 0).toFixed(4);
    const expectedAvg = (rows.reduce((sum, r) => sum + r.confidence, 0) / rows.length).toFixed(2);

    h.aggregateRow = {
      totalVerifications: expectedTotal,
      verified: expectedVerified,
      rejected: expectedRejected,
      avgConfidence: rows.reduce((sum, r) => sum + r.confidence, 0) / rows.length,
    };
    h.earnedTotal = rows.reduce((sum, r) => sum + Number(r.amountPaid), 0).toString();

    const res = await request(createTestApp()).get("/agent/status");

    expect(res.status).toBe(200);
    expect(res.body.stats.totalVerifications).toBe(expectedTotal);
    expect(res.body.stats.verified).toBe(expectedVerified);
    expect(res.body.stats.rejected).toBe(expectedRejected);
    expect(res.body.stats.totalEarned).toBe(expectedEarned);
    expect(res.body.stats.avgConfidence).toBe(expectedAvg);
  });

  it("does not read the full verifications table: only aggregates and 10 recent rows", async () => {
    h.aggregateRow = { totalVerifications: 5, verified: 4, rejected: 1, avgConfidence: 0.8 };
    h.earnedTotal = "0.5";
    h.recentRows = Array.from({ length: 10 }, (_, i) => ({
      id: `v${i}`,
      isOriginal: i % 2 === 0,
      confidence: 0.8,
      createdAt: new Date("2026-01-01T00:00:00Z"),
    }));

    const res = await request(createTestApp()).get("/agent/status");

    expect(res.status).toBe(200);
    expect(res.body.recentActivity).toHaveLength(10);

    // Every select must be either an aggregate or the limited recent query.
    for (const call of h.selectCalls) {
      expect(call.kind).not.toBe("other");
      if (call.kind === "recent") {
        expect(call.limit).toBe(10);
      }
    }
    expect(h.selectCalls.some((c) => c.kind === "aggregate")).toBe(true);
    expect(h.selectCalls.some((c) => c.kind === "recent" && c.limit === 10)).toBe(true);
  });
});
