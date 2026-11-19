import type { Request, Response, NextFunction } from "express";
import { eq } from "drizzle-orm";
import { config } from "../config.js";
import { db } from "../db/client.js";
import { publishers } from "../db/schema.js";
import { hashApiKey } from "../utils/crypto.js";
import { decryptSigningSecret } from "../utils/crypto.js";
import { signingKeyring } from "../lib/secretKeys.js";
import { AppError } from "../lib/errors.js";
import {
  EMPTY_BODY_HASH,
  getRequestPath,
  hashFile,
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
let pruneTimer: NodeJS.Timeout | null = setInterval(() => {
  const now = Date.now();
  for (const [sig, expiresAt] of inMemoryCache) {
    if (expiresAt <= now) inMemoryCache.delete(sig);
  }
}, 60_000);
pruneTimer.unref(); // don't keep the process alive

type ReplayRedisClient = import("redis").RedisClientType;

/** Connected client, set once connect() resolves. */
let redisClient: ReplayRedisClient | null = null;
let redisConnectPromise: Promise<void> | null = null;
/** Set by closeSignatureReplayStore(); stops new connections and reconnects. */
let replayStoreClosed = false;

// Reconnection is lazy (triggered by the next replay check) and rate-limited
// by a timestamp rather than a timer, so there is never pending reconnect work
// to cancel. node-redis' own reconnect loop is disabled (its backoff timers
// cannot be cancelled and a disconnect() racing an in-flight socket connect
// leaks that socket).
const RECONNECT_BASE_DELAY_MS = 500;
const RECONNECT_MAX_DELAY_MS = 30_000;
let reconnectAttempt = 0;
let nextConnectAttemptAt = 0;

function getRedisClient(): ReplayRedisClient | null {
  if (!config.REDIS_URL || replayStoreClosed) return null;
  if (redisClient?.isReady) return redisClient;
  if (redisClient && !redisClient.isOpen) {
    // Connection dropped; forget it so the next check reconnects.
    redisClient = null;
    redisConnectPromise = null;
  }
  if (!redisConnectPromise && Date.now() >= nextConnectAttemptAt) {
    redisConnectPromise = connectReplayRedis();
  }
  return null; // will be non-null after connect resolves
}

async function connectReplayRedis(): Promise<void> {
  let client: ReplayRedisClient | null = null;
  try {
    const { createClient } = await import("redis");
    if (replayStoreClosed) return;
    client = createClient({
      url: config.REDIS_URL,
      socket: {
        connectTimeout: 5_000,
        reconnectStrategy: () => new Error("Replay store reconnects are handled lazily"),
      },
    }) as ReplayRedisClient;
    client.on("error", () => {});
    await client.connect();
    if (replayStoreClosed) {
      // close() ran while we were connecting: shut this client down now.
      await quitOrDisconnect(client);
      return;
    }
    reconnectAttempt = 0;
    nextConnectAttemptAt = 0;
    redisClient = client;
  } catch (err) {
    if (client) await quitOrDisconnect(client);
    if (replayStoreClosed) return;
    rootLogger.warn({ event: "replay_cache_redis_unavailable", err }, "Redis replay cache unavailable — falling back to in-process cache");
    nextConnectAttemptAt =
      Date.now() + Math.min(RECONNECT_MAX_DELAY_MS, RECONNECT_BASE_DELAY_MS * 2 ** reconnectAttempt++);
    redisConnectPromise = null;
  }
}

/** Gracefully QUIT a ready client; force-close one that is not ready. */
async function quitOrDisconnect(client: ReplayRedisClient): Promise<void> {
  if (!client.isOpen) return;
  try {
    if (client.isReady) {
      await client.quit();
    } else {
      await client.disconnect();
    }
  } catch {
    try {
      await client.disconnect();
    } catch {
      // already closed
    }
  }
}

/**
 * Close the signature replay store: stop the prune timer, prevent any further
 * connect/reconnect attempts, and close the Redis connection. An in-flight
 * connect attempt is awaited (bounded by connectTimeout) and its client is
 * closed as soon as it settles, so no sockets or timers are left behind.
 * Safe to call more than once. After closing, replay checks fall back to the
 * in-process cache.
 */
export async function closeSignatureReplayStore(): Promise<void> {
  replayStoreClosed = true;
  if (pruneTimer) {
    clearInterval(pruneTimer);
    pruneTimer = null;
  }

  const client = redisClient;
  redisClient = null;
  const connecting = redisConnectPromise;
  redisConnectPromise = null;

  if (client) await quitOrDisconnect(client);
  if (connecting) await connecting.catch(() => {});
  inMemoryCache.clear();
}

/**
 * Check for a replayed signature, and mark it as seen.
 * Returns true when the signature has already been used (replay).
 */
async function checkAndMarkReplay(signature: string, ttlMs: number): Promise<boolean> {
  const redis = getRedisClient();
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

async function resolveBodyHash(req: Request): Promise<string> {
  const contentType = req.headers["content-type"] ?? "";

  if (contentType.includes("multipart/form-data")) {
    const fields = (req.body ?? {}) as Record<string, unknown>;
    const file = req.file as Express.Multer.File | undefined;
    if (!file) return hashMultipartBody(fields);
    // multer diskStorage exposes `path` (no `buffer`); hash the bytes that were
    // actually written to disk using bounded streaming reads.
    if (typeof file.path === "string" && file.path !== "") {
      return hashMultipartBody(fields, { sha256: await hashFile(file.path) });
    }
    if (Buffer.isBuffer(file.buffer)) {
      return hashMultipartBody(fields, { buffer: file.buffer });
    }
    throw new Error("Uploaded file has neither a disk path nor an in-memory buffer");
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

    // Decrypt if SIGNING_SECRET_KEY is configured (#42). Legacy keys from
    // SIGNING_SECRET_LEGACY_KEYS are accepted during a key rotation.
    const keyring = signingKeyring();
    if (keyring) {
      const plain = decryptSigningSecret(row.signingSecret, keyring);
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

  let bodyHash: string;
  try {
    bodyHash = await resolveBodyHash(req);
  } catch (err) {
    rootLogger.warn({ event: "request_signature_body_hash_failed", err }, "failed to hash request body for signature check");
    fail("Unable to verify request body");
    return;
  }

  const idempotencyHeader = req.headers["idempotency-key"];
  const valid = verifyRequestSignature({
    secret: signingSecret,
    method: req.method,
    path: getRequestPath(req.originalUrl),
    timestamp: timestampHeader,
    bodyHash,
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

/** Test helper — forget previously accepted signatures (in-process cache only). */
export function __resetSignatureReplayCache(): void {
  inMemoryCache.clear();
}

/** Test helper — trigger the Redis connection and report replay-store state. */
export async function __replayStoreStateForTests(): Promise<{
  closed: boolean;
  pruneTimerActive: boolean;
  client: ReplayRedisClient | null;
}> {
  getRedisClient();
  if (redisConnectPromise) await redisConnectPromise;
  return { closed: replayStoreClosed, pruneTimerActive: pruneTimer !== null, client: redisClient };
}
