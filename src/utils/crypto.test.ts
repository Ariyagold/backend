import { describe, it, expect } from "vitest";
import { hashFileResource, hashLinkResource } from "./crypto.js";

const BUF_HELLO = Buffer.from("hello world");
const BUF_HELLO2 = Buffer.from("hello world");

describe("hashFileResource (issue #12)", () => {
  it("returns a hex string of length 64", () => {
    const h = hashFileResource(BUF_HELLO, "My Title");
    expect(h).toMatch(/^[0-9a-f]{64}$/);
  });

  it("is stable — same input always yields same hash", () => {
    expect(hashFileResource(BUF_HELLO, "My Title")).toBe(hashFileResource(BUF_HELLO2, "My Title"));
  });

  it("changes when file bytes change", () => {
    expect(hashFileResource(Buffer.from("a"), "Same Title")).not.toBe(
      hashFileResource(Buffer.from("b"), "Same Title"),
    );
  });

  it("changes when title changes (same bytes)", () => {
    expect(hashFileResource(BUF_HELLO, "Title A")).not.toBe(hashFileResource(BUF_HELLO, "Title B"));
  });

  it("handles an empty buffer", () => {
    const h = hashFileResource(Buffer.alloc(0), "Empty File");
    expect(h).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("hashLinkResource (issue #13)", () => {
  const url = "https://example.com/path";
  const title = "Example Page";

  it("returns a hex string of length 64", () => {
    expect(hashLinkResource(url, title)).toMatch(/^[0-9a-f]{64}$/);
  });

  it("is stable — same URL and title always yield same hash", () => {
    expect(hashLinkResource(url, title)).toBe(hashLinkResource(url, title));
  });

  it("normalizes trailing slash on pathname", () => {
    expect(hashLinkResource("https://example.com/path/", title)).toBe(
      hashLinkResource("https://example.com/path", title),
    );
  });

  it("normalizes hostname to lowercase", () => {
    expect(hashLinkResource("https://EXAMPLE.COM/path", title)).toBe(
      hashLinkResource("https://example.com/path", title),
    );
  });

  it("normalizes query parameter order", () => {
    expect(hashLinkResource("https://example.com/?b=2&a=1", title)).toBe(
      hashLinkResource("https://example.com/?a=1&b=2", title),
    );
  });

  it("changes when URL changes", () => {
    expect(hashLinkResource("https://a.com", title)).not.toBe(
      hashLinkResource("https://b.com", title),
    );
  });

  it("changes when title changes", () => {
    expect(hashLinkResource(url, "Title A")).not.toBe(hashLinkResource(url, "Title B"));
  });
});

import {
  generateSigningSecret,
  encryptSigningSecret,
  decryptSigningSecret,
} from "./crypto.js";

describe("signing secret helpers (#42)", () => {
  const KEY = "test-encryption-key-32bytes-long!!";

  it("generateSigningSecret returns a svs_ prefixed hex string", () => {
    const s = generateSigningSecret();
    expect(s).toMatch(/^svs_[0-9a-f]{64}$/);
  });

  it("each call returns a unique secret", () => {
    expect(generateSigningSecret()).not.toBe(generateSigningSecret());
  });

  it("encrypt then decrypt round-trips correctly", () => {
    const plain = generateSigningSecret();
    const enc = encryptSigningSecret(plain, KEY);
    expect(enc).not.toBe(plain);
    expect(decryptSigningSecret(enc, KEY)).toBe(plain);
  });

  it("decryptSigningSecret returns null for wrong key", () => {
    const enc = encryptSigningSecret("svs_secret", KEY);
    expect(decryptSigningSecret(enc, "wrong-key-that-is-at-least-16chars")).toBeNull();
  });

  it("decryptSigningSecret returns null for tampered ciphertext", () => {
    const enc = encryptSigningSecret("svs_secret", KEY);
    const tampered = Buffer.from(enc, "base64");
    tampered[tampered.length - 1] ^= 0xff;
    expect(decryptSigningSecret(tampered.toString("base64"), KEY)).toBeNull();
  });

  it("ciphertext changes each call (different IV)", () => {
    const enc1 = encryptSigningSecret("svs_secret", KEY);
    const enc2 = encryptSigningSecret("svs_secret", KEY);
    expect(enc1).not.toBe(enc2);
  });
});

import {
  buildKeyring,
  decryptSecretDetailed,
  encryptSecret,
  isEnvelope,
  keyIdFor,
  parseKeyList,
} from "./crypto.js";
import { createCipheriv, createHash, randomBytes as rb } from "node:crypto";

/** Reproduces the pre-rotation (un-prefixed) ciphertext layout. */
function legacyEncrypt(plaintext: string, rawKey: string): string {
  const key = createHash("sha256").update(rawKey, "utf8").digest();
  const iv = rb(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv, { authTagLength: 16 });
  const enc = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), enc]).toString("base64");
}

describe("secret keyring / key rotation", () => {
  const OLD = "old-key-0123456789abcdef";
  const NEW = "new-key-fedcba9876543210";

  it("encodes the active key id in the ciphertext envelope", () => {
    const enc = encryptSecret("svs_x", buildKeyring(NEW)!);
    expect(enc.startsWith(`v1:${keyIdFor(NEW)}:`)).toBe(true);
    expect(isEnvelope(enc)).toBe(true);
    expect(enc).not.toContain("svs_x");
  });

  it("key ids are stable, distinct per key and do not expose the key", () => {
    expect(keyIdFor(NEW)).toBe(keyIdFor(NEW));
    expect(keyIdFor(NEW)).not.toBe(keyIdFor(OLD));
    expect(keyIdFor(NEW)).not.toContain(NEW);
    expect(createHash("sha256").update(NEW).digest("hex")).not.toContain(keyIdFor(NEW));
  });

  it("decrypts values written by a legacy key and marks them stale", () => {
    const enc = encryptSecret("svs_x", buildKeyring(OLD)!);
    const ring = buildKeyring(NEW, [OLD])!;
    expect(decryptSecretDetailed(enc, ring)).toEqual({ plaintext: "svs_x", keyId: keyIdFor(OLD), format: "v1", stale: true });
  });

  it("values written by the active key are not stale", () => {
    const ring = buildKeyring(NEW, [OLD])!;
    expect(decryptSecretDetailed(encryptSecret("s", ring), ring)?.stale).toBe(false);
  });

  it("fails closed when the envelope's key is no longer configured", () => {
    const enc = encryptSecret("svs_x", buildKeyring(OLD)!);
    expect(decryptSecretDetailed(enc, buildKeyring(NEW)!)).toBeNull();
  });

  it("reads pre-rotation un-prefixed ciphertext with active or legacy keys", () => {
    const fromOld = legacyEncrypt("svs_legacy", OLD);
    expect(decryptSecretDetailed(fromOld, buildKeyring(NEW, [OLD])!)).toMatchObject({
      plaintext: "svs_legacy",
      format: "legacy",
      stale: true,
    });
    expect(decryptSigningSecret(legacyEncrypt("svs_a", NEW), NEW)).toBe("svs_a");
  });

  it("rejects a tampered envelope", () => {
    const enc = encryptSecret("svs_x", NEW);
    const [v, kid, b64] = enc.split(":");
    const buf = Buffer.from(b64!, "base64");
    buf[buf.length - 1]! ^= 0xff;
    expect(decryptSecretDetailed(`${v}:${kid}:${buf.toString("base64")}`, NEW)).toBeNull();
  });

  it("buildKeyring returns null without an active key and dedupes legacy keys", () => {
    expect(buildKeyring(undefined, [OLD])).toBeNull();
    expect(buildKeyring(NEW, [OLD, OLD, NEW])!.decryptKeys.size).toBe(2);
  });

  it("parseKeyList splits and trims comma-separated keys", () => {
    expect(parseKeyList(" a , b,,c ")).toEqual(["a", "b", "c"]);
    expect(parseKeyList(undefined)).toEqual([]);
  });
});
