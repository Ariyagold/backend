import { beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";

// Exercises the real `validate` middleware (unlike verify.test.ts, which
// stubs it out) to confirm structural validation runs before any payment
// processing (#181): an invalid body must never reach the paywall,
// checkResourceForVerification's DB lookup, or checkOriginality.

const h = vi.hoisted(() => ({
  checkOriginality: vi.fn(),
  paywallHits: vi.fn(),
  resourceLookupHits: vi.fn(),
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

vi.mock("../services/webhookService.js", () => ({ emitToPublisher: vi.fn(), enqueueWebhookEvent: vi.fn() }));

vi.mock("../db/client.js", () => ({
  db: {
    select: vi.fn(() => {
      h.resourceLookupHits();
      const chain: any = { from: () => chain, where: () => chain, limit: () => Promise.resolve([]) };
      return chain;
    }),
    insert: vi.fn(),
    update: vi.fn(),
    transaction: vi.fn(async (cb: (tx: unknown) => Promise<unknown>) => cb({})),
  },
}));

vi.mock("../db/schema.js", () => ({
  resources: {},
  verifications: {},
  payments: {},
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

vi.mock("../middleware/apiKeyAuth.js", async () => {
  const { AppError } = await import("../lib/errors.js");
  return {
    apiKeyAuth: (req: any, _res: unknown, next: (err?: unknown) => void) => {
      const key = req.headers["x-api-key"];
      if (key === "key-pub-1") {
        req.publisher = { id: "pub-1" };
        return next();
      }
      next(new AppError("UNAUTHORIZED", "Missing x-api-key header"));
    },
  };
});

vi.mock("../middleware/rateLimiters.js", () => ({
  verifyIpRateLimit: (_req: unknown, _res: unknown, next: () => void) => next(),
  verifyWalletRateLimit: (_req: unknown, _res: unknown, next: () => void) => next(),
}));

// validate.js is intentionally NOT mocked here.

import verifyRouter from "./verify.js";
import { errorHandler } from "../middleware/errorHandler.js";

function createTestApp() {
  const app = express();
  app.use(express.json());
  app.use(verifyRouter);
  app.use(errorHandler);
  return app;
}

function expectRejectedBeforePaidWorkflow(res: { status: number }) {
  expect(res.status).toBe(400);
  expect(h.paywallHits).not.toHaveBeenCalled();
  expect(h.resourceLookupHits).not.toHaveBeenCalled();
  expect(h.checkOriginality).not.toHaveBeenCalled();
}

describe("POST /verify-content — validation runs before the paid workflow (#181)", () => {
  beforeEach(() => vi.clearAllMocks());

  it("rejects a body with no content before touching payment or the DB", async () => {
    const res = await request(createTestApp()).post("/verify-content").send({});
    expectRejectedBeforePaidWorkflow(res);
  });

  it("rejects a non-string content field", async () => {
    const res = await request(createTestApp())
      .post("/verify-content")
      .send({ content: 12345 });
    expectRejectedBeforePaidWorkflow(res);
  });

  it("rejects an empty content string", async () => {
    const res = await request(createTestApp()).post("/verify-content").send({ content: "" });
    expectRejectedBeforePaidWorkflow(res);
  });

  it("rejects a non-string resourceId even with an API key and valid content", async () => {
    const res = await request(createTestApp())
      .post("/verify-content")
      .set("x-api-key", "key-pub-1")
      .send({ content: "some content", resourceId: 42 });
    expectRejectedBeforePaidWorkflow(res);
  });

  it("rejects an unknown extra field (schema is strict)", async () => {
    const res = await request(createTestApp())
      .post("/verify-content")
      .send({ content: "some content", extra: "nope" });
    expectRejectedBeforePaidWorkflow(res);
  });

  it("still reaches the paywall for a structurally valid anonymous request", async () => {
    h.checkOriginality.mockResolvedValue({
      isOriginal: true,
      confidence: 0.9,
      flags: [],
      usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2, estimatedCostUsd: 0.0001 },
    });

    const res = await request(createTestApp()).post("/verify-content").send({ content: "valid content" });

    expect(res.status).toBe(200);
    expect(h.paywallHits).toHaveBeenCalledTimes(1);
  });
});
