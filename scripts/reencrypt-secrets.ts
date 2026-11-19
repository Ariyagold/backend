/**
 * Re-encrypt publisher signing / webhook secrets under the active key.
 *
 *   npm run secrets:reencrypt -- --dry-run
 *   npm run secrets:reencrypt -- [--field signing|webhook] [--batch-size 100]
 *                                [--after <publisherId>] [--max-batches N]
 *                                [--encrypt-plaintext]
 *
 * Resumable: progress lines print a `cursor`; pass it back with --after to
 * continue. Idempotent: rows already on the active key are skipped. Plaintext
 * secret values are never printed. See docs/secret-key-rotation.md.
 */
import { signingKeyring, webhookKeyring } from "../src/lib/secretKeys.js";
import { reencryptSecrets, type SecretField } from "../src/services/secretReencryption.js";

function parseArgs(argv: string[]) {
  const opts: {
    dryRun: boolean;
    encryptPlaintext: boolean;
    batchSize: number;
    after?: string;
    maxBatches?: number;
    fields: SecretField[];
  } = { dryRun: false, encryptPlaintext: false, batchSize: 100, fields: ["signingSecret", "webhookSecret"] };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const value = () => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`${arg} requires a value`);
      return v;
    };
    switch (arg) {
      case "--dry-run": opts.dryRun = true; break;
      case "--encrypt-plaintext": opts.encryptPlaintext = true; break;
      case "--batch-size": opts.batchSize = Math.max(1, Math.trunc(Number(value())) || 100); break;
      case "--after": opts.after = value(); break;
      case "--max-batches": opts.maxBatches = Math.max(1, Math.trunc(Number(value())) || 1); break;
      case "--field": {
        const f = value();
        if (f !== "signing" && f !== "webhook") throw new Error("--field must be 'signing' or 'webhook'");
        opts.fields = [f === "signing" ? "signingSecret" : "webhookSecret"];
        break;
      }
      default: throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return opts;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const keyrings = { signingSecret: signingKeyring(), webhookSecret: webhookKeyring() };
  for (const field of opts.fields) {
    if (!keyrings[field]) console.warn(`[reencrypt] no active key configured for ${field}; it will be reported as no_key`);
  }

  console.log(JSON.stringify({ event: "reencrypt_start", dryRun: opts.dryRun, fields: opts.fields, after: opts.after ?? null }));
  const report = await reencryptSecrets({
    ...opts,
    keyrings,
    onBatch: (p) => console.log(JSON.stringify({ event: "reencrypt_batch", batch: p.batch, rowsScanned: p.rowsScanned, cursor: p.cursor, counts: p.counts })),
  });
  console.log(JSON.stringify({ event: "reencrypt_done", ...report }));
  if (!report.done) console.log(`[reencrypt] stopped early — resume with --after ${report.cursor}`);
  process.exit(report.undecryptable.length > 0 ? 2 : 0);
}

main().catch((err: unknown) => {
  // Only the message: errors from the DB driver never contain secret values,
  // but avoid dumping arbitrary objects just in case.
  console.error(`[reencrypt] failed: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
