/**
 * Resumable re-encryption of secrets stored at rest (key rotation).
 *
 * Walks `publishers` in primary-key order, decrypting each signing / webhook
 * secret with the configured keyring and rewriting any value that is not yet
 * under the active key. Every write is a compare-and-swap on the old value so a
 * concurrent user rotation is never clobbered, and re-running the job is safe:
 * rows already on the active key are skipped.
 *
 * Plaintext secrets are NEVER logged or returned — reports carry row ids,
 * field names, outcome counts and the resume cursor only.
 */
import { and, asc, eq, gt } from "drizzle-orm";
import { db } from "../db/client.js";
import { publishers } from "../db/schema.js";
import { decryptSecretDetailed, encryptSecret, isEnvelope, type SecretKeyring } from "../utils/crypto.js";

export type SecretField = "signingSecret" | "webhookSecret";

export type FieldOutcome =
  | "current" // already encrypted under the active key
  | "rotated" // re-encrypted from a legacy key / legacy format
  | "encrypted_plaintext" // plaintext row encrypted (only with encryptPlaintext)
  | "plaintext_skipped" // looks like plaintext; left alone
  | "undecryptable" // envelope whose key isn't configured, or tampered
  | "conflict" // value changed concurrently; will be picked up on re-run
  | "no_key"; // no keyring configured for this field

export interface SecretRow {
  id: string;
  signingSecret: string | null;
  webhookSecret: string | null;
}

export interface ReencryptStore {
  fetchBatch(after: string | undefined, limit: number): Promise<SecretRow[]>;
  /** Compare-and-swap; resolves true when the row still held `expected`. */
  swap(id: string, field: SecretField, expected: string, next: string): Promise<boolean>;
}

export interface ReencryptOptions {
  keyrings: Record<SecretField, SecretKeyring | null>;
  fields?: SecretField[];
  dryRun?: boolean;
  batchSize?: number;
  /** Resume after this publisher id (exclusive). */
  after?: string;
  /** Encrypt values that don't decrypt and aren't envelopes (legacy plaintext rows). */
  encryptPlaintext?: boolean;
  /** Stop after this many batches (useful for throttled, incremental runs). */
  maxBatches?: number;
  store?: ReencryptStore;
  onBatch?: (progress: ReencryptProgress) => void;
}

export interface ReencryptProgress {
  batch: number;
  rowsScanned: number;
  /** Pass as `after` to resume from this point. */
  cursor: string | undefined;
  counts: Record<SecretField, Partial<Record<FieldOutcome, number>>>;
  /** Ids needing operator attention (undecryptable values). Never values. */
  undecryptable: { id: string; field: SecretField }[];
}

export interface ReencryptReport extends ReencryptProgress {
  dryRun: boolean;
  done: boolean;
}

export const drizzleReencryptStore: ReencryptStore = {
  async fetchBatch(after, limit) {
    return db
      .select({ id: publishers.id, signingSecret: publishers.signingSecret, webhookSecret: publishers.webhookSecret })
      .from(publishers)
      .where(after ? gt(publishers.id, after) : undefined)
      .orderBy(asc(publishers.id))
      .limit(limit);
  },
  async swap(id, field, expected, next) {
    const column = field === "signingSecret" ? publishers.signingSecret : publishers.webhookSecret;
    const rows = await db
      .update(publishers)
      .set({ [field]: next })
      .where(and(eq(publishers.id, id), eq(column, expected)))
      .returning({ id: publishers.id });
    return rows.length > 0;
  },
};

/** Decide what should happen to one stored value. Pure; exported for tests. */
export function planField(
  value: string,
  keyring: SecretKeyring | null,
  encryptPlaintext: boolean,
): { outcome: FieldOutcome; next?: string } {
  if (!keyring) return { outcome: "no_key" };
  const decrypted = decryptSecretDetailed(value, keyring);
  if (decrypted) {
    if (!decrypted.stale) return { outcome: "current" };
    return { outcome: "rotated", next: encryptSecret(decrypted.plaintext, keyring) };
  }
  // An envelope that no configured key opens must never be treated as plaintext.
  if (isEnvelope(value)) return { outcome: "undecryptable" };
  if (!encryptPlaintext) return { outcome: "plaintext_skipped" };
  return { outcome: "encrypted_plaintext", next: encryptSecret(value, keyring) };
}

export async function reencryptSecrets(options: ReencryptOptions): Promise<ReencryptReport> {
  const {
    keyrings,
    fields = ["signingSecret", "webhookSecret"],
    dryRun = false,
    batchSize = 100,
    encryptPlaintext = false,
    maxBatches = Number.POSITIVE_INFINITY,
    store = drizzleReencryptStore,
    onBatch,
  } = options;

  const progress: ReencryptProgress = {
    batch: 0,
    rowsScanned: 0,
    cursor: options.after,
    counts: { signingSecret: {}, webhookSecret: {} },
    undecryptable: [],
  };
  const bump = (field: SecretField, outcome: FieldOutcome) => {
    progress.counts[field][outcome] = (progress.counts[field][outcome] ?? 0) + 1;
  };

  let done = false;
  while (progress.batch < maxBatches) {
    const rows = await store.fetchBatch(progress.cursor, batchSize);
    if (rows.length === 0) {
      done = true;
      break;
    }

    for (const row of rows) {
      for (const field of fields) {
        const value = row[field];
        if (value === null || value === "") continue;
        const plan = planField(value, keyrings[field], encryptPlaintext);
        if (plan.outcome === "undecryptable") progress.undecryptable.push({ id: row.id, field });
        if (plan.next !== undefined && !dryRun) {
          const swapped = await store.swap(row.id, field, value, plan.next);
          bump(field, swapped ? plan.outcome : "conflict");
        } else {
          bump(field, plan.outcome);
        }
      }
    }

    progress.batch += 1;
    progress.rowsScanned += rows.length;
    progress.cursor = rows[rows.length - 1]!.id;
    onBatch?.({ ...progress, counts: structuredClone(progress.counts), undecryptable: [...progress.undecryptable] });

    if (rows.length < batchSize) {
      done = true;
      break;
    }
  }

  return { ...progress, dryRun, done };
}
