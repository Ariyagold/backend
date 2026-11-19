/**
 * Cache-Control: no-store policy for credential and private financial
 * responses. Exercises the real routers + error handler over HTTP and checks
 * headers on both successful and error responses.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";
import { createHash } from "node:crypto";
import { Keypair } from "@stellar/stellar-sdk";

const { PUBLISHERS_MARKER, RESOURCES_MARKER, PAYMENTS_MARKER, WEBHOOK_OUTBOX_MARKER } = vi.hoisted(() => ({
  PUBLISHERS_MARKER: { __table: "publishers" },
  RESOURCES_MARKER: { __table: "resources" },
  PAYMENTS_MARKER: { __table: "payments" },
  WEBHOOK_OUTBOX_MARKER: { __table: "webhook_outbox" },
}));

vi.mock("../db/schema.js", () => ({
  publishers: PUBLISHERS_MARKER,
  resources: RESOURCES_MARKER,
  payments: PAYMENTS_MARKER,
  webhookOutbox: WEBHOOK_OUTBOX_MARKER,
}));

const API_KEY = "mv_test-key";
const API_KEY_HASH = createHash("sha256").update(API_KEY).digest("hex");
const payer = Keypair.random();
const recipient = Keypair.random();

const publisher = {
  id: "pub-1",
  name: "Alice",
  email: "alice@example.com",
  walletAddress: recipient.publicKey(),
  apiKeyHash: API_KEY_HASH,
  apiKeyRevokedAt: null,
  rateLimitRpm: null,
  createdAt: new Date("2026-01-01"),
};
const payment = {
  id: "pay_1",
  resourceId: "res_1",
  amount: "1.00",
  payerAddress: payer.publicKey(),
  recipientAddress: recipient.publicKey(),
  paidAt: "2026-01-01T00:00:00.000Z",
};

let publisherRows: unknown[];
let paymentRows: unknown[];

vi.mock("../db/client.js", () => ({
  db: {
    select: () => ({
      from: (table: unknown) => {
        const rows = table === PUBLISHERS_MARKER ? publisherRows : paymentRows;
        const result = Promise.resolve(rows);
        return { where: () => Object.assign(result, { orderBy: () => result, limit: () => result }) };
      },
    }),
  },
}));

vi.mock("../config.js", () => ({
  config: {
    BASE_URL: "http://localhost:4021",
    PUBLISHER_RATE_LIMIT_RPM_DEFAULT: 60,
    PUBLISHER_RATE_LIMIT_MAX_RPM: 600,
    PUBLISHER_RATE_LIMIT_WINDOW_MS: 60_000,
  },
}));

const { registerPublisher, rotateApiKey, rotateSigningSecret } = vi.hoisted(() => ({
  registerPublisher: vi.fn(),
  rotateApiKey: vi.fn(),
  rotateSigningSecret: vi.fn(),
}));

vi.mock("../services/publisherService.js", () => ({
  registerPublisher,
  rotateApiKey,
  rotateSigningSecret,
  getPublisherResources: vi.fn(),
}));

import publisherRouter from "./publishers.js";
import paymentsRouter from "./payments.js";
import { errorHandler } from "../middleware/errorHandler.js";

function app() {
  const server = express();
  server.use(express.json());
  server.use(publisherRouter);
  server.use(paymentsRouter);
  server.use(errorHandler);
  return server;
}

function walletAuth(key: Keypair, path: string) {
  const timestamp = String(Math.floor(Date.now() / 1000));
  return {
    "x-wallet-address": key.publicKey(),
    "x-wallet-timestamp": timestamp,
    "x-wallet-signature": key
      .sign(Buffer.from(`synapsvault-wallet-auth-v2\nGET\n${path}\n\n${timestamp}`))
      .toString("base64"),
  };
}

function expectNoStore(res: request.Response) {
  expect(res.headers["cache-control"]).toBe("no-store");
  expect(res.headers["pragma"]).toBe("no-cache");
  expect(res.headers["expires"]).toBe("0");
}

beforeEach(() => {
  publisherRows = [publisher];
  paymentRows = [payment];
  registerPublisher.mockReset();
  rotateApiKey.mockReset();
  rotateSigningSecret.mockReset();
});

describe("Cache-Control: no-store on credential responses", () => {
  const VALID_WALLET = "GDEJJLXV2CNHF5HEGX34MU4G6L4PRVUAGD4ANF77ZDYTQJKSDSDYVVI6";

  it("POST /publishers — 201 with one-time credentials", async () => {
    registerPublisher.mockResolvedValue({
      publisher: { ...publisher, walletAddress: VALID_WALLET },
      apiKey: "mv_fresh",
      signingSecret: "svs_fresh",
    });
    const res = await request(app())
      .post("/publishers")
      .send({ name: "Alice", email: "alice@example.com", walletAddress: VALID_WALLET });
    expect(res.status).toBe(201);
    expect(res.body.apiKey).toBe("mv_fresh");
    expectNoStore(res);
  });

  it("POST /publishers — 400 validation error", async () => {
    const res = await request(app()).post("/publishers").send({ name: "" });
    expect(res.status).toBe(400);
    expectNoStore(res);
  });

  it("POST /publishers — 409 conflict", async () => {
    registerPublisher.mockRejectedValue(Object.assign(new Error("dup"), { code: "23505" }));
    const res = await request(app())
      .post("/publishers")
      .send({ name: "Alice", email: "alice@example.com", walletAddress: VALID_WALLET });
    expect(res.status).toBe(409);
    expectNoStore(res);
  });

  it.each([
    ["/publishers/me/api-keys/rotate", rotateApiKey, "mv_new"],
    ["/publishers/me/signing-secret/rotate", rotateSigningSecret, "svs_new"],
  ])("POST %s — 200 with rotated credential", async (path, rotate, value) => {
    rotate.mockResolvedValue(value);
    const res = await request(app()).post(path).set("x-api-key", API_KEY);
    expect(res.status).toBe(200);
    expect(JSON.stringify(res.body)).toContain(value);
    expectNoStore(res);
  });

  it.each(["/publishers/me/api-keys/rotate", "/publishers/me/signing-secret/rotate"])(
    "POST %s — 401 without an API key",
    async (path) => {
      const res = await request(app()).post(path);
      expect(res.status).toBe(401);
      expectNoStore(res);
    },
  );
});

describe("Cache-Control: no-store on wallet-authorized payment responses", () => {
  const historyPath = `/buyers/${payer.publicKey()}/payments`;
  const receiptPath = "/payments/pay_1/receipt";

  it("GET /buyers/:address/payments — 200", async () => {
    const res = await request(app()).get(historyPath).set(walletAuth(payer, historyPath));
    expect(res.status).toBe(200);
    expectNoStore(res);
  });

  it("GET /buyers/:address/payments — 401 without signature", async () => {
    const res = await request(app()).get(historyPath);
    expect(res.status).toBe(401);
    expectNoStore(res);
  });

  it("GET /payments/:id/receipt — 200 for the payer", async () => {
    const res = await request(app()).get(receiptPath).set(walletAuth(payer, receiptPath));
    expect(res.status).toBe(200);
    expectNoStore(res);
  });

  it("GET /payments/:id/receipt — 401 without credentials", async () => {
    const res = await request(app()).get(receiptPath);
    expect(res.status).toBe(401);
    expectNoStore(res);
  });

  it("GET /payments/:id/receipt — 403 for a different wallet", async () => {
    const other = Keypair.random();
    const res = await request(app()).get(receiptPath).set(walletAuth(other, receiptPath));
    expect(res.status).toBe(403);
    expectNoStore(res);
  });

  it("GET /payments/:id/receipt — 404 when the receipt does not exist", async () => {
    paymentRows = [];
    const res = await request(app()).get(receiptPath).set(walletAuth(payer, receiptPath));
    expect(res.status).toBe(404);
    expectNoStore(res);
  });
});

describe("no-store scope", () => {
  it("does not apply to public, non-credential responses", async () => {
    const res = await request(app()).get(`/publishers/wallet/${recipient.publicKey()}`);
    expect(res.status).toBe(200);
    expect(res.headers["cache-control"]).not.toBe("no-store");
  });
});
