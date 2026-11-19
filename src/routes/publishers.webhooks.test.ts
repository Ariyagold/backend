import { describe, it, expect, beforeEach, vi } from "vitest";
import express from "express";
import request from "supertest";

const { state, mockDeliver, mockConfig } = vi.hoisted(() => ({
  state: {
    publisher: null as Record<string, unknown> | null,
    lastSet: null as Record<string, unknown> | null,
  },
  mockDeliver: vi.fn(),
  mockConfig: {
    WEBHOOK_ENCRYPTION_KEY: undefined as string | undefined,
    WEBHOOK_SECRET_ENCRYPTION_REQUIRED: false,
  },
}));

vi.mock("../config.js", () => ({
  config: Object.assign(mockConfig, {
    NODE_ENV: "production",
    BASE_URL: "http://localhost:4021",
    PUBLISHER_RATE_LIMIT_RPM_DEFAULT: 60,
    PUBLISHER_RATE_LIMIT_MAX_RPM: 1000,
    PUBLISHER_RATE_LIMIT_WINDOW_MS: 60_000,
  }),
}));

vi.mock("../db/schema.js", () => ({
  publishers: { id: "id", rateLimitRpm: "rate_limit_rpm" },
  resources: {},
  payments: {},
}));

// update().set().where().returning() — echoes the merged row back.
vi.mock("../db/client.js", () => ({
  db: {
    update: () => ({
      set: (values: Record<string, unknown>) => {
        state.lastSet = values;
        return {
          where: () => ({
            returning: () => Promise.resolve([{ ...state.publisher, ...values }]),
          }),
        };
      },
    }),
  },
}));

vi.mock("../middleware/apiKeyAuth.js", () => ({
  apiKeyAuth: (req: any, res: any, next: any) => {
    if (!state.publisher) {
      res.status(401).json({ error: "Missing x-api-key header" });
      return;
    }
    req.publisher = state.publisher;
    next();
  },
}));

vi.mock("../middleware/rateLimiters.js", () => ({
  publisherRateLimit: (_req: any, _res: any, next: any) => next(),
  registerIpRateLimit: (_req: any, _res: any, next: any) => next(),
}));

vi.mock("../services/publisherService.js", async (importOriginal) => ({
  encodeWebhookSecretForStorage: (await importOriginal<typeof import("../services/publisherService.js")>())
    .encodeWebhookSecretForStorage,
  registerPublisher: vi.fn(),
  getPublisherResources: vi.fn(),
}));

vi.mock("../services/webhookService.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../services/webhookService.js")>()),
  deliver: mockDeliver,
}));

import publisherRouter from "./publishers.js";
import { decryptWebhookSecret, isEnvelope } from "../utils/crypto.js";
import { errorHandler } from "../middleware/errorHandler.js";

const app = express().use(express.json()).use(publisherRouter).use(errorHandler);

function basePublisher(overrides: Record<string, unknown> = {}) {
  return {
    id: "pub-1",
    name: "Alice",
    email: "alice@example.com",
    walletAddress: "GALICE",
    rateLimitRpm: null,
    webhookUrl: null,
    webhookSecret: null,
    webhookEvents: null,
    webhookEnabled: false,
    ...overrides,
  };
}

describe("publisher rate-limit routes", () => {
  beforeEach(() => {
    state.publisher = basePublisher();
    state.lastSet = null;
  });

  it("requires authentication", async () => {
    state.publisher = null;
    expect((await request(app).get("/publishers/me/rate-limit")).status).toBe(401);
    expect((await request(app).patch("/publishers/me/rate-limit").send({ rateLimitRpm: 5 })).status).toBe(401);
  });

  it("returns the platform default when there is no override", async () => {
    const res = await request(app).get("/publishers/me/rate-limit");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      rateLimitRpm: 60,
      override: null,
      defaultRpm: 60,
      maxRpm: 1000,
      windowMs: 60_000,
    });
  });

  it("updates the override", async () => {
    const res = await request(app).patch("/publishers/me/rate-limit").send({ rateLimitRpm: 120 });
    expect(res.status).toBe(200);
    expect(state.lastSet).toEqual({ rateLimitRpm: 120 });
    expect(res.body).toMatchObject({ rateLimitRpm: 120, override: 120 });
  });

  it("resets the override with null", async () => {
    state.publisher = basePublisher({ rateLimitRpm: 500 });
    const res = await request(app).patch("/publishers/me/rate-limit").send({ rateLimitRpm: null });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ rateLimitRpm: 60, override: null });
  });

  it.each([{ rateLimitRpm: -5 }, { rateLimitRpm: "fast" }, { rateLimitRpm: 5000 }, {}, { rateLimitRpm: 5, extra: 1 }])(
    "rejects invalid payload %j",
    async (body) => {
      const res = await request(app).patch("/publishers/me/rate-limit").send(body);
      expect(res.status).toBe(400);
      expect(res.body.code).toBe("VALIDATION_ERROR");
      expect(state.lastSet).toBeNull();
    },
  );
});

describe("publisher webhook routes", () => {
  beforeEach(() => {
    state.publisher = basePublisher();
    state.lastSet = null;
    mockDeliver.mockReset();
  });

  it("requires authentication", async () => {
    state.publisher = null;
    expect((await request(app).get("/publishers/me/webhooks")).status).toBe(401);
    expect((await request(app).patch("/publishers/me/webhooks").send({ webhookEnabled: true })).status).toBe(401);
    expect((await request(app).post("/publishers/me/webhooks/test")).status).toBe(401);
  });

  it("returns the configuration with a masked secret", async () => {
    state.publisher = basePublisher({
      webhookUrl: "https://hooks.example.com/a",
      webhookSecret: "abcdefghijklmnop1234",
      webhookEvents: ["resource.purchased"],
      webhookEnabled: true,
    });
    const res = await request(app).get("/publishers/me/webhooks");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      webhookUrl: "https://hooks.example.com/a",
      webhookSecret: "****************1234",
      webhookEvents: ["resource.purchased"],
      webhookEnabled: true,
    });
  });

  it("returns an empty configuration by default", async () => {
    const res = await request(app).get("/publishers/me/webhooks");
    expect(res.body).toEqual({ webhookUrl: null, webhookSecret: null, webhookEvents: [], webhookEnabled: false });
  });

  it("updates the configuration and masks the secret in the response", async () => {
    const res = await request(app).patch("/publishers/me/webhooks").send({
      webhookUrl: "https://hooks.example.com/b",
      webhookSecret: "a-very-long-secret-value",
      webhookEvents: ["payment.received"],
      webhookEnabled: true,
    });
    expect(res.status).toBe(200);
    expect(state.lastSet).toMatchObject({ webhookUrl: "https://hooks.example.com/b", webhookEnabled: true });
    expect(res.body.webhookSecret).toMatch(/^\*+alue$/);
    expect(res.body.webhookEvents).toEqual(["payment.received"]);
  });

  it("disables delivery when the URL is cleared", async () => {
    state.publisher = basePublisher({ webhookUrl: "https://hooks.example.com/a", webhookEnabled: true });
    const res = await request(app).patch("/publishers/me/webhooks").send({ webhookUrl: null });
    expect(res.status).toBe(200);
    expect(state.lastSet).toEqual({ webhookUrl: null, webhookEnabled: false });
  });

  it.each([
    [{ webhookUrl: "not-a-url" }],
    [{ webhookUrl: "https://127.0.0.1/hook" }],
    [{ webhookUrl: "http://hooks.example.com/plain" }],
    [{ webhookSecret: "short" }],
    [{ webhookEvents: ["article.published"] }],
    [{ webhookEnabled: true }],
    [{}],
  ])("rejects %j", async (body) => {
    const res = await request(app).patch("/publishers/me/webhooks").send(body);
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("VALIDATION_ERROR");
    expect(state.lastSet).toBeNull();
  });

  it("requires a configured URL to send a test event", async () => {
    const res = await request(app).post("/publishers/me/webhooks/test");
    expect(res.status).toBe(400);
    expect(mockDeliver).not.toHaveBeenCalled();
  });

  it("sends a signed test event", async () => {
    state.publisher = basePublisher({ webhookUrl: "https://hooks.example.com/a", webhookSecret: "s".repeat(16) });
    mockDeliver.mockResolvedValue({ delivered: true, attempts: 1, status: 200 });

    const res = await request(app).post("/publishers/me/webhooks/test");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ delivered: true, attempts: 1, status: 200 });
    expect(mockDeliver).toHaveBeenCalledWith(
      { url: "https://hooks.example.com/a", secret: "s".repeat(16) },
      expect.objectContaining({ event: "webhook.test", data: { publisherId: "pub-1" } }),
      { maxAttempts: 1 },
    );
  });

  it("returns 502 when the test delivery fails", async () => {
    state.publisher = basePublisher({ webhookUrl: "https://hooks.example.com/a" });
    mockDeliver.mockResolvedValue({ delivered: false, attempts: 3, error: "HTTP 500", status: 500 });
    const res = await request(app).post("/publishers/me/webhooks/test");
    expect(res.status).toBe(502);
    expect(res.body.delivered).toBe(false);
  });
});

describe("webhook secret encryption enforcement", () => {
  const KEY = "webhook-encryption-key-0123456789";
  const SECRET = "whsec_super_secret_value_1234";

  beforeEach(() => {
    state.publisher = basePublisher({ webhookUrl: "https://hooks.example.com/a" });
    state.lastSet = null;
    mockDeliver.mockReset();
    mockConfig.WEBHOOK_ENCRYPTION_KEY = undefined;
    mockConfig.WEBHOOK_SECRET_ENCRYPTION_REQUIRED = false;
  });

  it("stores the secret encrypted when a key is configured", async () => {
    mockConfig.WEBHOOK_ENCRYPTION_KEY = KEY;
    mockConfig.WEBHOOK_SECRET_ENCRYPTION_REQUIRED = true;
    const res = await request(app).patch("/publishers/me/webhooks").send({ webhookSecret: SECRET });
    expect(res.status).toBe(200);
    const stored = state.lastSet!.webhookSecret as string;
    expect(stored).not.toBe(SECRET);
    expect(isEnvelope(stored)).toBe(true);
    expect(decryptWebhookSecret(stored, KEY)).toBe(SECRET);
    expect(JSON.stringify(res.body)).not.toContain(SECRET);
  });

  it("rejects secret writes when encryption is required but no key is configured", async () => {
    mockConfig.WEBHOOK_SECRET_ENCRYPTION_REQUIRED = true;
    const res = await request(app)
      .patch("/publishers/me/webhooks")
      .send({ webhookUrl: "https://hooks.example.com/b", webhookSecret: SECRET, webhookEnabled: true });
    expect(res.status).toBe(503);
    expect(res.body.code).toBe("SERVICE_UNAVAILABLE");
    expect(JSON.stringify(res.body)).not.toContain(SECRET);
    // Nothing (URL included) is persisted when the secret is rejected.
    expect(state.lastSet).toBeNull();
  });

  it("still allows changes that store no secret while enforcement blocks secrets", async () => {
    mockConfig.WEBHOOK_SECRET_ENCRYPTION_REQUIRED = true;

    const disable = await request(app).patch("/publishers/me/webhooks").send({ webhookEnabled: false });
    expect(disable.status).toBe(200);
    expect(state.lastSet).toEqual({ webhookEnabled: false });

    const clear = await request(app).patch("/publishers/me/webhooks").send({ webhookSecret: null });
    expect(clear.status).toBe(200);
    expect(state.lastSet).toEqual({ webhookSecret: null });

    const enable = await request(app).patch("/publishers/me/webhooks").send({ webhookEnabled: true });
    expect(enable.status).toBe(200);
  });

  it("keeps sending test events for an existing plaintext secret under enforcement", async () => {
    mockConfig.WEBHOOK_SECRET_ENCRYPTION_REQUIRED = true;
    state.publisher = basePublisher({ webhookUrl: "https://hooks.example.com/a", webhookSecret: SECRET });
    mockDeliver.mockResolvedValue({ delivered: true, attempts: 1 });
    const res = await request(app).post("/publishers/me/webhooks/test");
    expect(res.status).toBe(200);
    expect(mockDeliver.mock.calls[0]![0]).toMatchObject({ secret: SECRET });
  });

  it("stores plaintext when enforcement is off and no key is configured (dev)", async () => {
    const res = await request(app).patch("/publishers/me/webhooks").send({ webhookSecret: SECRET });
    expect(res.status).toBe(200);
    expect(state.lastSet!.webhookSecret).toBe(SECRET);
  });
});
