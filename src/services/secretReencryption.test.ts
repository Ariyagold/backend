import { describe, it, expect, vi } from "vitest";

vi.mock("../db/client.js", () => ({ db: {} }));
vi.mock("../db/schema.js", () => ({ publishers: {} }));

import { reencryptSecrets, planField, type ReencryptStore, type SecretRow } from "./secretReencryption.js";
import { buildKeyring, decryptSecretDetailed, encryptSecret, keyIdFor } from "../utils/crypto.js";

const OLD = "old-key-0123456789abcdef";
const NEW = "new-key-fedcba9876543210";
const oldRing = buildKeyring(OLD)!;
const ring = buildKeyring(NEW, [OLD])!;

function memoryStore(rows: SecretRow[]): ReencryptStore & { rows: SecretRow[]; swaps: number } {
  const store = {
    rows,
    swaps: 0,
    async fetchBatch(after: string | undefined, limit: number) {
      return rows
        .filter((r) => after === undefined || r.id > after)
        .sort((a, b) => a.id.localeCompare(b.id))
        .slice(0, limit)
        .map((r) => ({ ...r }));
    },
    async swap(id: string, field: "signingSecret" | "webhookSecret", expected: string, next: string) {
      const row = rows.find((r) => r.id === id)!;
      if (row[field] !== expected) return false;
      row[field] = next;
      store.swaps++;
      return true;
    },
  };
  return store;
}

function seed(): SecretRow[] {
  return [
    { id: "a", signingSecret: encryptSecret("svs_secret_a", oldRing), webhookSecret: null },
    { id: "b", signingSecret: encryptSecret("svs_secret_b", ring), webhookSecret: encryptSecret("whsec_b_plain", oldRing) },
    { id: "c", signingSecret: "svs_plaintext_c", webhookSecret: "whsec_plaintext_value_c" },
    { id: "d", signingSecret: encryptSecret("svs_lost", buildKeyring("some-removed-key-000000")!), webhookSecret: null },
  ];
}

const keyrings = { signingSecret: ring, webhookSecret: ring };

describe("planField", () => {
  it("never treats an undecryptable envelope as plaintext", () => {
    const enc = encryptSecret("x", buildKeyring("gone-gone-gone-gone-gone")!);
    expect(planField(enc, ring, true)).toEqual({ outcome: "undecryptable" });
  });

  it("reports no_key when the field has no keyring", () => {
    expect(planField("anything", null, true)).toEqual({ outcome: "no_key" });
  });
});

describe("reencryptSecrets", () => {
  it("dry-run reports outcomes without writing", async () => {
    const store = memoryStore(seed());
    const before = JSON.stringify(store.rows);
    const report = await reencryptSecrets({ keyrings, dryRun: true, store });

    expect(store.swaps).toBe(0);
    expect(JSON.stringify(store.rows)).toBe(before);
    expect(report.done).toBe(true);
    expect(report.counts.signingSecret).toEqual({ rotated: 1, current: 1, plaintext_skipped: 1, undecryptable: 1 });
    expect(report.counts.webhookSecret).toEqual({ rotated: 1, plaintext_skipped: 1 });
    expect(report.undecryptable).toEqual([{ id: "d", field: "signingSecret" }]);
  });

  it("re-encrypts stale rows under the active key and is idempotent", async () => {
    const store = memoryStore(seed());
    await reencryptSecrets({ keyrings, store });

    const a = decryptSecretDetailed(store.rows[0]!.signingSecret!, ring)!;
    expect(a).toMatchObject({ plaintext: "svs_secret_a", keyId: keyIdFor(NEW), stale: false });
    expect(decryptSecretDetailed(store.rows[1]!.webhookSecret!, ring)).toMatchObject({ plaintext: "whsec_b_plain", stale: false });
    expect(store.rows[2]!.signingSecret).toBe("svs_plaintext_c"); // plaintext untouched without the flag

    const second = await reencryptSecrets({ keyrings, store });
    expect(second.counts.signingSecret.rotated).toBeUndefined();
    expect(second.counts.webhookSecret.rotated).toBeUndefined();
  });

  it("encrypts plaintext rows only with encryptPlaintext", async () => {
    const store = memoryStore(seed());
    const report = await reencryptSecrets({ keyrings, store, encryptPlaintext: true });
    expect(report.counts.signingSecret.encrypted_plaintext).toBe(1);
    expect(decryptSecretDetailed(store.rows[2]!.webhookSecret!, ring)?.plaintext).toBe("whsec_plaintext_value_c");
  });

  it("resumes from a cursor across interrupted runs", async () => {
    const store = memoryStore(seed());
    const first = await reencryptSecrets({ keyrings, store, batchSize: 1, maxBatches: 1 });
    expect(first.done).toBe(false);
    expect(first.cursor).toBe("a");

    const second = await reencryptSecrets({ keyrings, store, batchSize: 1, after: first.cursor });
    expect(second.done).toBe(true);
    expect(second.rowsScanned).toBe(3);
    expect(second.counts.signingSecret.rotated).toBeUndefined(); // "a" already done
  });

  it("does not clobber a concurrent change (compare-and-swap)", async () => {
    const store = memoryStore(seed());
    const realSwap = store.swap;
    store.swap = async (id, field, expected, next) => {
      if (id === "a") store.rows[0]!.signingSecret = encryptSecret("svs_user_rotated", ring);
      return realSwap(id, field, expected, next);
    };
    const report = await reencryptSecrets({ keyrings, store });
    expect(report.counts.signingSecret.conflict).toBe(1);
    expect(decryptSecretDetailed(store.rows[0]!.signingSecret!, ring)?.plaintext).toBe("svs_user_rotated");
  });

  it("never exposes plaintext in progress or report output", async () => {
    const store = memoryStore(seed());
    const lines: string[] = [];
    const report = await reencryptSecrets({ keyrings, store, encryptPlaintext: true, batchSize: 2, onBatch: (p) => lines.push(JSON.stringify(p)) });
    const output = lines.join("\n") + JSON.stringify(report);
    for (const secret of ["svs_secret_a", "svs_secret_b", "whsec_b_plain", "svs_plaintext_c", "whsec_plaintext_value_c", OLD, NEW]) {
      expect(output).not.toContain(secret);
    }
  });
});
