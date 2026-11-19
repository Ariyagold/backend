import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { createReadStream } from "node:fs";

/** Chunk size used when hashing disk-backed uploads (bounded memory). */
export const FILE_HASH_CHUNK_BYTES = 64 * 1024;

/** SHA-256 hex digest of an empty body (used for DELETE and bodyless POST). */
export const EMPTY_BODY_HASH = createHash("sha256").update(Buffer.alloc(0)).digest("hex");

export function hashRequestBody(body: Buffer | string): string {
  const buf = typeof body === "string" ? Buffer.from(body, "utf8") : body;
  return createHash("sha256").update(buf).digest("hex");
}

/**
 * SHA-256 hex digest of a file on disk, read as a stream in fixed-size chunks
 * so memory use stays bounded regardless of upload size.
 */
export function hashFile(path: string, chunkBytes = FILE_HASH_CHUNK_BYTES): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    const stream = createReadStream(path, { highWaterMark: chunkBytes });
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", () => resolve(hash.digest("hex")));
  });
}

/**
 * Canonical SHA-256 of multipart publish fields. Form keys are sorted; when a
 * file is present its raw bytes are hashed and included as `file=<hex>`.
 * Callers may pass either the in-memory bytes or a precomputed file digest
 * (e.g. from {@link hashFile} for multer diskStorage uploads).
 */
export function hashMultipartBody(
  fields: Record<string, unknown>,
  file?: { buffer: Buffer } | { sha256: string },
): string {
  const sortedKeys = Object.keys(fields).sort();
  const lines = sortedKeys.map((key) => `${key}=${String(fields[key] ?? "")}`);
  if (file) {
    const digest = "sha256" in file ? file.sha256 : createHash("sha256").update(file.buffer).digest("hex");
    lines.push(`file=${digest}`);
  }
  return hashRequestBody(lines.join("\n"));
}

/** Path and query from the request URL (no scheme/host). */
export function getRequestPath(originalUrl: string): string {
  const hashIndex = originalUrl.indexOf("#");
  return hashIndex === -1 ? originalUrl : originalUrl.slice(0, hashIndex);
}

export function buildCanonicalString(params: {
  method: string;
  path: string;
  timestamp: string;
  bodyHash: string;
  idempotencyKey?: string;
}): string {
  const parts = [params.method.toUpperCase(), params.path, params.timestamp, params.bodyHash];
  if (params.idempotencyKey) {
    parts.push(params.idempotencyKey);
  }
  return parts.join("\n");
}

export function computeRequestSignature(secret: string, canonical: string): string {
  return createHmac("sha256", secret).update(canonical, "utf8").digest("hex");
}

export function signPublisherRequest(params: {
  secret: string;
  method: string;
  path: string;
  timestamp: string;
  bodyHash: string;
  idempotencyKey?: string;
}): string {
  const canonical = buildCanonicalString(params);
  return computeRequestSignature(params.secret, canonical);
}

export function verifyRequestSignature(params: {
  secret: string;
  method: string;
  path: string;
  timestamp: string;
  bodyHash: string;
  idempotencyKey?: string;
  signature: string;
}): boolean {
  const expected = signPublisherRequest(params);
  return timingSafeEqualHex(expected, params.signature);
}

export function timingSafeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length || a.length !== 64) {
    return false;
  }
  try {
    return timingSafeEqual(Buffer.from(a, "hex"), Buffer.from(b, "hex"));
  } catch {
    return false;
  }
}

export function isTimestampWithinSkew(
  timestampSeconds: number,
  nowMs: number,
  maxSkewMs: number,
): boolean {
  if (!Number.isFinite(timestampSeconds)) {
    return false;
  }
  const requestMs = timestampSeconds * 1000;
  return Math.abs(nowMs - requestMs) <= maxSkewMs;
}
