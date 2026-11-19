import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  EMPTY_BODY_HASH,
  buildCanonicalString,
  hashFile,
  hashMultipartBody,
  hashRequestBody,
  isTimestampWithinSkew,
  signPublisherRequest,
  verifyRequestSignature,
} from "./requestSignature.js";

describe("requestSignature", () => {
  const secret = "mv_test_secret_key";
  const timestamp = "1710000000";
  const path = "/resources/abc/register";
  const body = JSON.stringify({ signedXdr: "AAAA..." });
  const bodyHash = hashRequestBody(body);

  it("uses the known empty-body hash", () => {
    expect(EMPTY_BODY_HASH).toBe(
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    );
  });

  it("builds a canonical string with optional idempotency key", () => {
    expect(
      buildCanonicalString({
        method: "post",
        path,
        timestamp,
        bodyHash,
      }),
    ).toBe(`POST\n${path}\n${timestamp}\n${bodyHash}`);

    expect(
      buildCanonicalString({
        method: "POST",
        path,
        timestamp,
        bodyHash,
        idempotencyKey: "idem-1",
      }),
    ).toBe(`POST\n${path}\n${timestamp}\n${bodyHash}\nidem-1`);
  });

  it("signs and verifies a JSON mutation", () => {
    const signature = signPublisherRequest({
      secret,
      method: "POST",
      path,
      timestamp,
      bodyHash,
    });

    expect(
      verifyRequestSignature({
        secret,
        method: "POST",
        path,
        timestamp,
        bodyHash,
        signature,
      }),
    ).toBe(true);
  });

  it("rejects a tampered signature", () => {
    const signature = signPublisherRequest({
      secret,
      method: "POST",
      path,
      timestamp,
      bodyHash,
    });

    expect(
      verifyRequestSignature({
        secret,
        method: "POST",
        path: "/resources/other/register",
        timestamp,
        bodyHash,
        signature,
      }),
    ).toBe(false);
  });

  it("hashes multipart fields in sorted order with file digest", () => {
    const withoutFile = hashMultipartBody({ price: "1.00", title: "Doc" });
    const withFile = hashMultipartBody(
      { price: "1.00", title: "Doc" },
      { buffer: Buffer.from("hello") },
    );
    expect(withoutFile).not.toBe(withFile);
    expect(withoutFile).toMatch(/^[0-9a-f]{64}$/);
  });

  it("hashes a file on disk in bounded chunks to the same digest as its bytes", async () => {
    const dir = await mkdtemp(join(tmpdir(), "hash-file-"));
    try {
      const bytes = Buffer.alloc(200_000, 7);
      const file = join(dir, "f.bin");
      await writeFile(file, bytes);
      const expected = createHash("sha256").update(bytes).digest("hex");
      expect(await hashFile(file, 1024)).toBe(expected);
      expect(hashMultipartBody({ a: "1" }, { sha256: expected })).toBe(
        hashMultipartBody({ a: "1" }, { buffer: bytes }),
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  describe("isTimestampWithinSkew", () => {
    beforeEach(() => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2024-03-10T12:00:00Z"));
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it("accepts timestamps within the window", () => {
      const now = Date.now();
      const ts = Math.floor(now / 1000);
      expect(isTimestampWithinSkew(ts, now, 300_000)).toBe(true);
    });

    it("rejects stale timestamps outside the window", () => {
      const now = Date.now();
      const ts = Math.floor((now - 600_000) / 1000);
      expect(isTimestampWithinSkew(ts, now, 300_000)).toBe(false);
    });
  });
});
