/**
 * Shared-Redis replay protection across replicas.
 *
 * Each "replica" is a fresh import of the middleware module (own Redis
 * client, own in-process fallback cache) talking to one shared fake Redis.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Request, Response, NextFunction } from "express";

const TEST_SIGNING_SECRET = "svs_test_signing_secret_value_for_hmac";

const mockConfig = vi.hoisted(() => ({
  REQUIRE_REQUEST_SIGNATURE: true,
  SIGNATURE_MAX_SKEW_MS: 300_000,
  SIGNING_SECRET_KEY: undefined as string | undefined,
  REDIS_URL: "redis://shared:6379" as string | undefined,
  REPLAY_REDIS_CONNECT_TIMEOUT_MS: 500,
  REPLAY_PROTECTION_FAILURE_MODE: "closed" as "closed" | "open",
}));

/** One Redis server shared by every replica. */
const fakeRedis = vi.hoisted(() => {
  const store = new Map<string, string>();
  const clients: Array<{ isOpen: boolean; isReady: boolean }> = [];
  const state = { connectDelayMs: 50, down: false, connects: 0 };
  return { store, clients, state };
});

vi.mock("redis", () => ({
  createClient: () => {
    const handlers: Record<string, (() => void)[]> = {};
    const client = {
      isOpen: false,
      isReady: false,
      on(event: string, fn: () => void) {
        (handlers[event] ??= []).push(fn);
        return client;
      },
      async connect() {
        fakeRedis.state.connects++;
        await new Promise((r) => setTimeout(r, fakeRedis.state.connectDelayMs));
        if (fakeRedis.state.down) throw new Error("ECONNREFUSED");
        client.isOpen = true;
        client.isReady = true;
      },
      async set(key: string, value: string, opts: { NX?: boolean }) {
        if (fakeRedis.state.down || !client.isReady) throw new Error("The client is closed");
        if (opts.NX && fakeRedis.store.has(key)) return null;
        fakeRedis.store.set(key, value);
        return "OK";
      },
      async disconnect() {
        client.isOpen = false;
        client.isReady = false;
        for (const fn of handlers.end ?? []) fn();
      },
    };
    fakeRedis.clients.push(client);
    return client;
  },
}));

vi.mock("../config.js", () => ({ config: mockConfig }));

vi.mock("../db/client.js", () => ({
  db: {
    select: () => ({
      from: () => ({
        where: () => ({
          limit: () => Promise.resolve([{ signingSecret: TEST_SIGNING_SECRET }]),
        }),
      }),
    }),
  },
}));

vi.mock("../db/schema.js", () => ({
  publishers: { apiKeyHash: "api_key_hash", signingSecret: "signing_secret" },
}));

vi.mock("../utils/crypto.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../utils/crypto.js")>()),
  hashApiKey: (key: string) => `hashed_${key}`,
  decryptSigningSecret: (val: string) => val,
}));

import { hashRequestBody, signPublisherRequest } from "../utils/requestSignature.js";

type Middleware = (req: Request, res: Response, next: NextFunction) => Promise<void>;

/** Boot a fresh replica: new module instance → new Redis client + local cache. */
async function bootReplica(): Promise<Middleware> {
  vi.resetModules();
  const mod = await import("./requestSignatureAuth.js");
  return mod.requestSignatureAuth;
}

const path = "/resources/res-1/register";
let nonce = 0;

/** A freshly signed request; each call yields a distinct signature. */
function signedRequest(): Request {
  const rawBody = JSON.stringify({ signedXdr: `AAAA${nonce++}` });
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const signature = signPublisherRequest({
    secret: TEST_SIGNING_SECRET,
    method: "POST",
    path,
    timestamp,
    bodyHash: hashRequestBody(rawBody),
  });
  return {
    method: "POST",
    originalUrl: path,
    headers: { "x-api-key": "k", "x-timestamp": timestamp, "x-signature": signature },
    rawBody: Buffer.from(rawBody, "utf8"),
  } as unknown as Request;
}

function cloneRequest(req: Request): Request {
  return { ...req, headers: { ...req.headers } } as Request;
}

/** Run the middleware and report whether the mutation was allowed through. */
async function run(mw: Middleware, req: Request): Promise<{ allowed: boolean; err?: any }> {
  const next = vi.fn();
  await mw(req, {} as Response, next as unknown as NextFunction);
  const err = next.mock.calls[0]?.[0];
  return { allowed: next.mock.calls.length === 1 && err === undefined, err };
}

beforeEach(() => {
  fakeRedis.store.clear();
  fakeRedis.clients.length = 0;
  fakeRedis.state.connectDelayMs = 50;
  fakeRedis.state.down = false;
  fakeRedis.state.connects = 0;
  mockConfig.REDIS_URL = "redis://shared:6379";
  mockConfig.REPLAY_REDIS_CONNECT_TIMEOUT_MS = 500;
  mockConfig.REPLAY_PROTECTION_FAILURE_MODE = "closed";
});

/** Simulate Redis going away: commands fail, connections drop, reconnects refused. */
function redisOutage() {
  fakeRedis.state.down = true;
  for (const c of fakeRedis.clients) {
    c.isOpen = false;
    c.isReady = false;
  }
}

describe("replay protection — Redis cold start", () => {
  it("awaits Redis init so two cold replicas allow at most one mutation per signature", async () => {
    const replicaA = await bootReplica();
    const replicaB = await bootReplica();
    const req = signedRequest();

    // Both replicas receive the same signature before either Redis client is connected.
    const results = await Promise.all([run(replicaA, req), run(replicaB, cloneRequest(req))]);

    expect(results.filter((r) => r.allowed)).toHaveLength(1);
    expect(results.find((r) => !r.allowed)?.err?.message).toBe("Request signature already used");
    expect(fakeRedis.store.size).toBe(1);
  });

  it("shares one connection attempt across concurrent cold-start requests", async () => {
    const replica = await bootReplica();
    await Promise.all([run(replica, signedRequest()), run(replica, signedRequest())]);
    expect(fakeRedis.state.connects).toBe(1);
  });

  it("bounds the wait for Redis initialization (and fails closed past it)", async () => {
    fakeRedis.state.connectDelayMs = 5_000;
    mockConfig.REPLAY_REDIS_CONNECT_TIMEOUT_MS = 50;
    const replica = await bootReplica();

    const started = Date.now();
    const result = await run(replica, signedRequest());
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(result.allowed).toBe(false);
    expect(result.err).toMatchObject({ status: 503, code: "SERVICE_UNAVAILABLE" });
  });

  it("uses only the in-process cache when REDIS_URL is unset", async () => {
    mockConfig.REDIS_URL = undefined;
    const replica = await bootReplica();
    const req = signedRequest();

    expect((await run(replica, req)).allowed).toBe(true);
    expect((await run(replica, cloneRequest(req))).allowed).toBe(false);
    expect(fakeRedis.state.connects).toBe(0);
  });
});

describe("replay protection — Redis outage policy", () => {
  it("fail-closed: rejects on both replicas during an outage, then recovers with shared guarantees", async () => {
    const replicaA = await bootReplica();
    const replicaB = await bootReplica();

    // Healthy: both replicas connected and enforcing via Redis.
    expect((await run(replicaA, signedRequest())).allowed).toBe(true);
    expect((await run(replicaB, signedRequest())).allowed).toBe(true);

    // Outage: the same signature sent to both replicas — neither may mutate.
    redisOutage();
    const duringOutage = signedRequest();
    const outage = await Promise.all([
      run(replicaA, duringOutage),
      run(replicaB, cloneRequest(duringOutage)),
    ]);
    for (const r of outage) {
      expect(r.allowed).toBe(false);
      expect(r.err).toMatchObject({ status: 503, code: "SERVICE_UNAVAILABLE" });
    }

    // Recovery: replicas reconnect on the next request; the signature that was
    // rejected (never consumed) is now accepted exactly once across both.
    fakeRedis.state.down = false;
    const afterRecovery = await Promise.all([
      run(replicaA, duringOutage),
      run(replicaB, cloneRequest(duringOutage)),
    ]);
    expect(afterRecovery.filter((r) => r.allowed)).toHaveLength(1);
    expect(afterRecovery.find((r) => !r.allowed)?.err?.message).toBe("Request signature already used");
  });

  it("fail-closed: rejects when a Redis command fails on a seemingly ready client", async () => {
    const replica = await bootReplica();
    expect((await run(replica, signedRequest())).allowed).toBe(true);

    fakeRedis.state.down = true; // client still reports ready; SET throws
    const result = await run(replica, signedRequest());
    expect(result.err).toMatchObject({ status: 503, code: "SERVICE_UNAVAILABLE" });
  });

  it("fail-open: stays available but cannot stop a cross-replica replay during the outage", async () => {
    mockConfig.REPLAY_PROTECTION_FAILURE_MODE = "open";
    const replicaA = await bootReplica();
    const replicaB = await bootReplica();
    await run(replicaA, signedRequest());
    await run(replicaB, signedRequest());

    redisOutage();
    const req = signedRequest();
    const results = await Promise.all([run(replicaA, req), run(replicaB, cloneRequest(req))]);
    // Documented tradeoff: each replica's local cache accepts the signature once.
    expect(results.every((r) => r.allowed)).toBe(true);
    // Same replica still rejects the replay locally.
    expect((await run(replicaA, cloneRequest(req))).allowed).toBe(false);

    // After recovery the shared guarantee is restored.
    fakeRedis.state.down = false;
    const fresh = signedRequest();
    const recovered = await Promise.all([run(replicaA, fresh), run(replicaB, cloneRequest(fresh))]);
    expect(recovered.filter((r) => r.allowed)).toHaveLength(1);
  });
});
