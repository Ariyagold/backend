import { beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";
import { Keypair } from "@stellar/stellar-sdk";

const { select } = vi.hoisted(() => ({ select: vi.fn() }));
vi.mock("../db/client.js", () => ({ db: { select } }));

import paymentsRouter from "./payments.js";
import { errorHandler } from "../middleware/errorHandler.js";

const payer = Keypair.random();
const recipient = Keypair.random();
const other = Keypair.random();
const receiptPath = "/payments/pay_123/receipt";
const payment = {
  id: "pay_123",
  resourceId: "resource_123",
  payerAddress: payer.publicKey(),
  recipientAddress: recipient.publicKey(),
  amount: "1.00",
  paidAt: "2026-01-01T00:00:00.000Z",
};

function app() {
  const server = express();
  server.use(paymentsRouter);
  server.use(errorHandler);
  return server;
}

function rows(value: unknown[]) {
  const result = Promise.resolve(value);
  select.mockReturnValueOnce({
    from: () => ({ where: () => Object.assign(result, { orderBy: () => result }) }),
  });
}

function auth(key: Keypair, path: string, timestamp = String(Math.floor(Date.now() / 1000)), query = "") {
  return {
    "x-wallet-address": key.publicKey(),
    "x-wallet-timestamp": timestamp,
    "x-wallet-signature": key
      .sign(Buffer.from(`synapsvault-wallet-auth-v2\nGET\n${path}\n${query}\n${timestamp}`))
      .toString("base64"),
  };
}

function authV1(key: Keypair, path: string, timestamp = String(Math.floor(Date.now() / 1000))) {
  return {
    "x-wallet-address": key.publicKey(),
    "x-wallet-timestamp": timestamp,
    "x-wallet-signature": key.sign(Buffer.from(`synapsvault-wallet-auth-v1\nGET\n${path}\n${timestamp}`)).toString("base64"),
  };
}

beforeEach(() => vi.resetAllMocks());

describe("GET /payments/:id/receipt", () => {
  it("returns a receipt to its payer using a real Stellar signature", async () => {
    rows([payment]);
    const res = await request(app()).get(receiptPath).set(auth(payer, receiptPath));
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      ...payment,
      terms: { version: null, legacy: true, network: null, asset: null, content: null },
    });
  });

  it("returns snapshotted terms, not current resource state, for a versioned receipt", async () => {
    rows([{
      ...payment,
      receiptVersion: 1,
      network: "stellar:testnet",
      asset: "CUSDC",
      resourceTitle: "Original title",
      resourceType: "file",
      resourceContentHash: "hash-at-purchase",
    }]);
    const res = await request(app()).get(receiptPath).set(auth(payer, receiptPath));
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      ...payment,
      terms: {
        version: 1,
        legacy: false,
        network: "stellar:testnet",
        asset: { code: "USDC", contract: "CUSDC" },
        content: { title: "Original title", type: "file", contentHash: "hash-at-purchase" },
      },
    });
  });

  it("returns a receipt to the recipient authenticated with an API key", async () => {
    rows([{ walletAddress: recipient.publicKey() }]);
    rows([payment]);
    const res = await request(app()).get(receiptPath).set("x-api-key", "publisher-key");
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject(payment);
    expect(res.body.terms.legacy).toBe(true);
  });

  it("rejects unauthenticated requests before querying payments", async () => {
    const res = await request(app()).get(receiptPath);
    expect(res.status).toBe(401);
    expect(select).not.toHaveBeenCalled();
  });

  it("rejects an invalid API key", async () => {
    rows([]);
    const res = await request(app()).get(receiptPath).set("x-api-key", "invalid-key");
    expect(res.status).toBe(401);
    expect(select).toHaveBeenCalledTimes(1);
  });

  it("rejects an unrelated wallet", async () => {
    rows([payment]);
    const res = await request(app()).get(receiptPath).set(auth(other, receiptPath));
    expect(res.status).toBe(403);
  });

  it("rejects an unrelated publisher", async () => {
    rows([{ walletAddress: other.publicKey() }]);
    rows([payment]);
    const res = await request(app()).get(receiptPath).set("x-api-key", "other-key");
    expect(res.status).toBe(403);
  });

  it("returns 404 for a missing receipt", async () => {
    rows([]);
    const res = await request(app()).get(receiptPath).set(auth(payer, receiptPath));
    expect(res.status).toBe(404);
  });
});

describe("GET /buyers/:address/payments", () => {
  const path = `/buyers/${payer.publicKey()}/payments`;

  it("returns history to the authenticated buyer", async () => {
    rows([payment]);
    const res = await request(app()).get(path).set(auth(payer, path));
    expect(res.status).toBe(200);
    expect(res.body).toEqual([payment]);
  });

  it.each(["missing", "invalid", "expired", "other-wallet", "other-path"])("rejects %s signatures", async (kind) => {
    const headers: Record<string, string> = kind === "missing" ? {} : auth(
      kind === "other-wallet" ? other : payer,
      kind === "other-path" ? receiptPath : path,
      kind === "expired" ? String(Math.floor(Date.now() / 1000) - 600) : undefined,
    );
    if (kind === "invalid") headers["x-wallet-signature"] = "invalid";
    const res = await request(app()).get(path).set(headers);
    expect(res.status).toBe(401);
    expect(select).not.toHaveBeenCalled();
  });
});

describe("wallet-auth v2 query binding", () => {
  const path = `/buyers/${payer.publicKey()}/payments`;

  it("accepts a v2 signature over the canonical query regardless of parameter order or encoding", async () => {
    rows([payment]);
    const res = await request(app())
      .get(`${path}?status=settled&limit=10&note=a+b`)
      .set(auth(payer, path, undefined, "limit=10&note=a%20b&status=settled"));
    expect(res.status).toBe(200);
  });

  it.each([
    ["changed pagination", "?limit=100"],
    ["changed filter", "?limit=10&status=pending"],
    ["added parameter", "?limit=10&status=settled&cursor=abc"],
    ["removed parameter", "?limit=10"],
    ["duplicated parameter", "?limit=10&limit=10&status=settled"],
  ])("rejects a signature when the query has a %s", async (_label, query) => {
    const res = await request(app())
      .get(`${path}${query}`)
      .set(auth(payer, path, undefined, "limit=10&status=settled"));
    expect(res.status).toBe(401);
    expect(select).not.toHaveBeenCalled();
  });

  it("still accepts a legacy v1 signature when there is no query string", async () => {
    rows([payment]);
    const res = await request(app()).get(path).set(authV1(payer, path));
    expect(res.status).toBe(200);
  });

  it("rejects a legacy v1 signature when the request has a query string", async () => {
    const res = await request(app()).get(`${path}?limit=10`).set(authV1(payer, path));
    expect(res.status).toBe(401);
    expect(select).not.toHaveBeenCalled();
  });
});
