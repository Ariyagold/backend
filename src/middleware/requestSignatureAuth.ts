import type { Request, Response, NextFunction } from "express";
import { eq } from "drizzle-orm";
import { config } from "../config.js";
import { db } from "../db/client.js";
import { publishers } from "../db/schema.js";
import { hashApiKey } from "../utils/crypto.js";
import { decryptSigningSecret } from "../utils/crypto.js";
import { AppError } from "../lib/errors.js";
import {
  EMPTY_BODY_HASH,
  getRequestPath,
  hashMultipartBody,
  hashRequestBody,
  isTimestampWithinSkew,
  verifyRequestSignature,
} from "../utils/requestSignature.js";
import { rootLogger } from "../lib/logger.js";

declare global {
  namespace Express {
    interface Request {
      /** Raw request body bytes captured by express.json verify (JSON routes). */
      rawBody?: Buffer;
    }
  }
}

// ── Replay cache ─────────────────────────────────────────────────────────────
//
// #43: use Redis SET NX + TTL when REDIS_URL is set so replay protection works
// across replicas. Fall back to an in-process Map when Redis is not configured,
// but prune on a timer instead of on every request.

/** In-process fallback: signature → expiry timestamp (ms). */
const inMemoryCache = new Map<string, number>();

/** Prune expired entries on a timer (every 60 s) — not on every request (#43). */
const pruneTimer = setInterval(() => {
  const now = Date.now();
  for (const [sig, expiresAt] of inMemoryCache) {
    if (expiresAt <= now) inMemoryCache.delete(sig);
  }
}, 60_000);
pruneTimer.unref(); // don't keep the process alive

type RedisClient = import("redis").RedisClientType;

let redisClient: RedisClient | null = null;
let redisConnectPromise: Promise<RedisClient | null> | null = null;

/** Open one shared Redis connection; resolves null (and allows a retry) on failure. */
function connectRedis(): Promise<RedisClient | null> {
  return (async () => {
    try {
      const { createClient } = await import("redis");
      const client = createClient({
        url: config.REDIS_URL,
        // Fail commands fast while disconnected instead of queueing them, so
        // a replay check never silently waits on a dead connection.
        disableOfflineQueue: true,
        socket: {
          connectTimeout: config.REPLAY_REDIS_CONNECT_TIMEOUT_MS,
          reconnectStrategy: (retries: number) =>
            retries >= 3 ? new Error("Redis unreachable") : 200 * (retries + 1),
        },
      }) as RedisClient;
      client.on("error", () => {});
      client.on("end", () => {
        if (redisClient === client) {
          redisClient = null;
          redisConnectPromise = null;
        }
      });
      await client.connect();
      redisClient = client;
      return client;
    } catch (err) {
      rootLogger.warn({ event: "replay_cache_redis_unavailable", err }, "Redis replay cache unavailable");
      redisClient = null;
      redisConnectPromise = null;
      return null;
    }
  })();
}

/** Resolve with `promise`, or with null after `ms` (the underlying work continues). */
function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T | null> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), ms);
    timer.unref?.();
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/**
 * Return a ready shared Redis client, waiting (bounded by
 * REPLAY_REDIS_CONNECT_TIMEOUT_MS) for the initial connection so cold-start
 * requests use the shared store instead of per-process memory. Returns null
 * when Redis is not configured, or not ready within the bound.
 */
async function getRedisClient(): Promise<RedisClient | null> {
  if (!config.REDIS_URL) return null;
  if (redisClient?.isReady) return redisClient;

  // A client that exhausted its reconnect budget is closed for good — drop
  // it so the next call opens a fresh connection (recovery after an outage).
  if (redisClient && !redisClient.isOpen) {
    const stale = redisClient;
    redisClient = null;
    redisConnectPromise = null;
    void stale.disconnect().catch(() => {});
  }

  if (!redisConnectPromise) redisConnectPromise = connectRedis();
  const client = await withTimeout(redisConnectPromise, config.REPLAY_REDIS_CONNECT_TIMEOUT_MS);
  return client?.isReady ? client : null;
}

/**
 * Check for a replayed signature, and mark it as seen.
 * Returns true when the signature has already been used (replay).
 */
async function checkAndMarkReplay(signature: string, ttlMs: number): Promise<boolean> {
  const redis = await getRedisClient();
  if (redis) {
    // SET NX with TTL — atomic; works across replicas (#43).
    const key = `replay:${signature}`;
    const ttlSeconds = Math.ceil(ttlMs / 1000);
    try {
      const set = await redis.set(key, "1", { NX: true, EX: ttlSeconds });
      // set === null means key already existed → replay
      return set === null;
    } catch (err) {
      rootLogger.warn({ event: "replay_cache_redis_error", err }, "Redis replay check failed — falling back to in-process cache");
    }
  }

  // In-process fallback.
  const now = Date.now();
  if (inMemoryCache.has(signature)) return true;
  inMemoryCache.set(signature, now + ttlMs);
  return false;
}

// ── Body hashing ─────────────────────────────────────────────────────────────

function resolveBodyHash(req: Request): string {
  const contentType = req.headers["content-type"] ?? "";

  if (contentType.includes("multipart/form-data")) {
    const file = req.file as Express.Multer.File | undefined;
    return hashMultipartBody(
      req.body as Record<string, unknown>,
      file ? { buffer: file.buffer } : undefined,
    );
  }

  if (req.rawBody !== undefined) {
    return hashRequestBody(req.rawBody);
  }

  if (req.method === "DELETE" || req.method === "GET") {
    return EMPTY_BODY_HASH;
  }

  return EMPTY_BODY_HASH;
}

// ── Middleware ────────────────────────────────────────────────────────────────

/**
 * HMAC-SHA256 request signature verification for publisher mutations (#42, #43).
 *
 * When REQUIRE_REQUEST_SIGNATURE is false (default outside production), this
 * middleware is a no-op.
 *
 * Expects:
 *   x-api-key     — publisher API key (identifies the publisher to look up their signing secret)
 *   X-Timestamp   — unix seconds
 *   X-Signature   — hex HMAC-SHA256 of the canonical string, keyed by the publisher's signing secret
 *
 * The HMAC secret is the publisher's per-record signing secret (#42), NOT the
 * raw API key. Signatures made with the API key alone are rejected.
 */
export async function requestSignatureAuth(req: Request, res: Response, next: NextFunction) {
  if (!config.REQUIRE_REQUEST_SIGNATURE) {
    next();
    return;
  }

  const fail = (message: string) => next(new AppError("UNAUTHORIZED", message));

  const apiKey = req.headers["x-api-key"];
  if (typeof apiKey !== "string") {
    fail("Missing x-api-key header");
    return;
  }

  const timestampHeader = req.headers["x-timestamp"];
  const signatureHeader = req.headers["x-signature"];
  if (
    !timestampHeader || typeof timestampHeader !== "string" ||
    !signatureHeader || typeof signatureHeader !== "string"
  ) {
    fail("Missing request signature headers");
    return;
  }

  const timestampSeconds = Number(timestampHeader);
  if (!/^\d+$/.test(timestampHeader) || !Number.isSafeInteger(timestampSeconds)) {
    fail("Invalid request timestamp");
    return;
  }
  const now = Date.now();
  if (!isTimestampWithinSkew(timestampSeconds, now, config.SIGNATURE_MAX_SKEW_MS)) {
    fail("Request timestamp outside allowed window");
    return;
  }

  // Look up the publisher by API key hash to retrieve their signing secret (#42).
  let signingSecret: string;
  try {
    const apiKeyHash = hashApiKey(apiKey);
    const [row] = await db
      .select({ signingSecret: publishers.signingSecret })
      .from(publishers)
      .where(eq(publishers.apiKeyHash, apiKeyHash))
      .limit(1);

    if (!row || !row.signingSecret) {
      fail("No signing secret found — rotate your signing secret first");
      return;
    }

    // Decrypt if SIGNING_SECRET_KEY is configured (#42).
    if (config.SIGNING_SECRET_KEY) {
      const plain = decryptSigningSecret(row.signingSecret, config.SIGNING_SECRET_KEY);
      if (!plain) {
        fail("Invalid signing secret configuration");
        return;
      }
      signingSecret = plain;
    } else {
      signingSecret = row.signingSecret;
    }
  } catch {
    fail("Failed to load signing secret");
    return;
  }

  const idempotencyHeader = req.headers["idempotency-key"];
  const valid = verifyRequestSignature({
    secret: signingSecret,
    method: req.method,
    path: getRequestPath(req.originalUrl),
    timestamp: timestampHeader,
    bodyHash: resolveBodyHash(req),
    idempotencyKey: typeof idempotencyHeader === "string" ? idempotencyHeader : undefined,
    signature: signatureHeader,
  });
  if (!valid) {
    fail("Invalid request signature");
    return;
  }

  // Replay protection (#43).
  try {
    const isReplay = await checkAndMarkReplay(signatureHeader, config.SIGNATURE_MAX_SKEW_MS * 2);
    if (isReplay) {
      fail("Request signature already used");
      return;
    }
  } catch {
    fail("Replay check failed");
    return;
  }

  next();
}

/** Test helper — forget previously accepted signatures and drop the Redis client. */
export function __resetSignatureReplayCache(): void {
  inMemoryCache.clear();
  const client = redisClient;
  redisClient = null;
  redisConnectPromise = null;
  if (client) void client.disconnect().catch(() => {});
}
