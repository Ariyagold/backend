import { randomBytes, createHash, createCipheriv, createDecipheriv } from "node:crypto";

export function generateApiKey(): string {
  return `mv_${randomBytes(32).toString("hex")}`;
}

export function hashApiKey(key: string): string {
  return createHash("sha256").update(key).digest("hex");
}

export function hashContentUrl(url: string): string {
  return createHash("sha256").update(url).digest("hex");
}

export function calculateContentHash(buffer: Buffer): string {
  return createHash("sha256").update(buffer).digest("hex");
}

/**
 * SHA-256 over file bytes + title for the on-chain metadata integrity anchor.
 * The title is encoded as UTF-8 and prepended before the file bytes so the
 * hash changes if the title changes even when the bytes are identical.
 */
export function hashFileResource(buffer: Buffer, title: string): string {
  return createHash("sha256").update(Buffer.from(title, "utf8")).update(buffer).digest("hex");
}

/**
 * SHA-256 of normalized external URL + title for link resource metadata.
 * Normalization: lowercase scheme+host, strip trailing slash from pathname,
 * sort query parameters alphabetically so equivalent URLs produce the same hash.
 */
export function hashLinkResource(url: string, title: string): string {
  const normalized = normalizeUrl(url);
  return createHash("sha256").update(normalized).update(Buffer.from(title, "utf8")).digest("hex");
}

function normalizeUrl(raw: string): string {
  const u = new URL(raw);
  u.hostname = u.hostname.toLowerCase();
  u.pathname = u.pathname.replace(/\/+$/, "") || "/";
  const sorted = Array.from(u.searchParams.entries()).sort(([a], [b]) => a.localeCompare(b));
  u.search = "";
  sorted.forEach(([k, v]) => u.searchParams.append(k, v));
  return u.toString();
}

// ── Signing secret helpers (#42) ────────────────────────────────────────────

/** Generate a per-publisher HMAC signing secret (shown once, never stored raw). */
export function generateSigningSecret(): string {
  return `svs_${randomBytes(32).toString("hex")}`;
}

const ALGO = "aes-256-gcm";
const IV_LEN = 12; // 96-bit nonce recommended for GCM
const TAG_LEN = 16;

/**
 * Versioned ciphertext envelope: `v1:<keyId>:<base64(iv | tag | ciphertext)>`.
 * Base64 never contains ":" so the prefix can't collide with a legacy
 * (un-prefixed) value written before key rotation existed.
 */
const ENVELOPE_VERSION = "v1";
const ENVELOPE_RE = /^v1:([0-9a-f]{8,64}):([A-Za-z0-9+/=]+)$/;

/**
 * Derive a 32-byte AES key from a configured key string using a
 * deterministic SHA-256 hash (no salt needed; the key itself is the secret).
 */
function deriveKey(rawKey: string): Buffer {
  return createHash("sha256").update(rawKey, "utf8").digest();
}

/**
 * Stable, non-secret identifier for a configured key. Domain-separated from
 * the AES key derivation so the id reveals nothing usable about the key, and
 * derived (not configured) so operators can't accidentally reuse an id.
 */
export function keyIdFor(rawKey: string): string {
  return createHash("sha256").update("synapsvault/secret-key-id/v1\0").update(rawKey, "utf8").digest("hex").slice(0, 16);
}

export interface SecretKey {
  id: string;
  key: Buffer;
}

/**
 * One active write key plus any number of legacy decrypt-only keys (#key-rotation).
 * New ciphertext is always written with `active`; reads accept any key in
 * `decryptKeys` (which includes the active key).
 */
export interface SecretKeyring {
  active: SecretKey;
  decryptKeys: Map<string, SecretKey>;
}

/**
 * Build a keyring from the active key and a list of legacy keys. Returns null
 * when no active key is configured (secrets are then stored unencrypted —
 * see config for the enforcement rules).
 */
export function buildKeyring(activeRaw: string | undefined, legacyRaw: readonly string[] = []): SecretKeyring | null {
  if (!activeRaw) return null;
  const active: SecretKey = { id: keyIdFor(activeRaw), key: deriveKey(activeRaw) };
  const decryptKeys = new Map<string, SecretKey>([[active.id, active]]);
  for (const raw of legacyRaw) {
    if (!raw) continue;
    const id = keyIdFor(raw);
    if (!decryptKeys.has(id)) decryptKeys.set(id, { id, key: deriveKey(raw) });
  }
  return { active, decryptKeys };
}

/** Parse a comma-separated list of legacy keys from an env value. */
export function parseKeyList(value: string | undefined): string[] {
  return (value ?? "")
    .split(",")
    .map((k) => k.trim())
    .filter((k) => k.length > 0);
}

function asKeyring(keys: string | SecretKeyring): SecretKeyring {
  return typeof keys === "string" ? buildKeyring(keys)! : keys;
}

function sealRaw(plaintext: string, key: Buffer): Buffer {
  const iv = randomBytes(IV_LEN);
  const cipher = createCipheriv(ALGO, key, iv, { authTagLength: TAG_LEN });
  const enc = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  // Layout: [iv (12)] [tag (16)] [ciphertext]
  return Buffer.concat([iv, cipher.getAuthTag(), enc]);
}

function openRaw(buf: Buffer, key: Buffer): string | null {
  try {
    if (buf.length < IV_LEN + TAG_LEN + 1) return null;
    const iv = buf.subarray(0, IV_LEN);
    const tag = buf.subarray(IV_LEN, IV_LEN + TAG_LEN);
    const ciphertext = buf.subarray(IV_LEN + TAG_LEN);
    const decipher = createDecipheriv(ALGO, key, iv, { authTagLength: TAG_LEN });
    decipher.setAuthTag(tag);
    return decipher.update(ciphertext).toString("utf8") + decipher.final("utf8");
  } catch {
    return null;
  }
}

/** True when `value` carries the versioned `v1:<keyId>:` envelope. */
export function isEnvelope(value: string): boolean {
  return ENVELOPE_RE.test(value);
}

/**
 * Encrypt `plaintext` with AES-256-GCM under the keyring's active key.
 * Accepts a raw key string for backwards compatibility.
 */
export function encryptSecret(plaintext: string, keys: string | SecretKeyring): string {
  const { active } = asKeyring(keys);
  return `${ENVELOPE_VERSION}:${active.id}:${sealRaw(plaintext, active.key).toString("base64")}`;
}

export interface DecryptedSecret {
  plaintext: string;
  /** Id of the key that successfully decrypted the value. */
  keyId: string;
  /** "legacy" = un-prefixed ciphertext written before key ids existed. */
  format: "v1" | "legacy";
  /** True when the value should be rewritten under the active key. */
  stale: boolean;
}

/**
 * Decrypt a stored value, reporting which key opened it. Envelope values are
 * only tried against the key their id names; legacy values are tried against
 * every configured key (active first). Returns null when nothing opens it —
 * wrong/removed key, tampering, or a value that was never encrypted.
 */
export function decryptSecretDetailed(encoded: string, keys: string | SecretKeyring): DecryptedSecret | null {
  const keyring = asKeyring(keys);
  const match = ENVELOPE_RE.exec(encoded);
  if (match) {
    const key = keyring.decryptKeys.get(match[1]!);
    if (!key) return null;
    const plaintext = openRaw(Buffer.from(match[2]!, "base64"), key.key);
    if (plaintext === null) return null;
    return { plaintext, keyId: key.id, format: "v1", stale: key.id !== keyring.active.id };
  }

  const buf = Buffer.from(encoded, "base64");
  const candidates = [keyring.active, ...[...keyring.decryptKeys.values()].filter((k) => k.id !== keyring.active.id)];
  for (const key of candidates) {
    const plaintext = openRaw(buf, key.key);
    if (plaintext !== null) return { plaintext, keyId: key.id, format: "legacy", stale: true };
  }
  return null;
}

/** Decrypt a stored value; null when no configured key opens it. */
export function decryptSecret(encoded: string, keys: string | SecretKeyring): string | null {
  return decryptSecretDetailed(encoded, keys)?.plaintext ?? null;
}

/**
 * Encrypt a per-publisher signing secret (#42). Output is the versioned
 * envelope `v1:<keyId>:<base64>` so keys can be rotated without rewriting
 * every row at once.
 */
export function encryptSigningSecret(plaintext: string, keys: string | SecretKeyring): string {
  return encryptSecret(plaintext, keys);
}

/**
 * Decrypt a value produced by `encryptSigningSecret` (or a pre-rotation
 * un-prefixed value). Returns null when the key is wrong or the ciphertext is
 * malformed / tampered.
 */
export function decryptSigningSecret(encoded: string, keys: string | SecretKeyring): string | null {
  return decryptSecret(encoded, keys);
}

// ── Webhook secret helpers (#47) ────────────────────────────────────────────

/** Encrypt a webhook secret with AES-256-GCM (same envelope as signing secrets). */
export function encryptWebhookSecret(plaintext: string, keys: string | SecretKeyring): string {
  return encryptSecret(plaintext, keys);
}

/**
 * Decrypt a value produced by `encryptWebhookSecret`.
 * Returns null when the key is wrong or the ciphertext is malformed / tampered.
 */
export function decryptWebhookSecret(encoded: string, keys: string | SecretKeyring): string | null {
  return decryptSecret(encoded, keys);
}
