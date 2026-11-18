import { and, asc, eq, gt } from "drizzle-orm";
import { db, pgClient } from "../src/db/client.js";
import { resources } from "../src/db/schema.js";
import { StorageNotFoundError, downloadFile } from "../src/storage/supabaseStorage.js";
import { hashFileResource } from "../src/utils/crypto.js";

const MAX_LIMIT = 5_000;
const DEFAULT_LIMIT = 500;

function parseArgs(args: string[]): { limit: number; after?: string; dryRun: boolean } {
  let limit = DEFAULT_LIMIT;
  let after: string | undefined;
  let dryRun = false;

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case "--limit": {
        const parsed = Number(args[++i]);
        if (!Number.isInteger(parsed) || parsed < 1 || parsed > MAX_LIMIT) {
          throw new Error(`--limit must be an integer from 1 to ${MAX_LIMIT}`);
        }
        limit = parsed;
        break;
      }
      case "--after":
        after = args[++i];
        if (!after) throw new Error("--after requires a resource id");
        break;
      case "--dry-run":
        dryRun = true;
        break;
      default:
        throw new Error(`Unknown argument: ${args[i]}`);
    }
  }

  return { limit, after, dryRun };
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const issues: Array<{
    resourceId: string;
    storagePath: string;
    status: "missing" | "mismatch" | "error";
    expectedHash?: string;
    actualHash?: string;
    error?: string;
  }> = [];
  let checked = 0;
  let cursor = options.after;

  while (checked < options.limit) {
    const batchSize = Math.min(100, options.limit - checked);
    const rows = await db
      .select({
        id: resources.id,
        title: resources.title,
        storagePath: resources.storagePath,
        contentHash: resources.contentHash,
      })
      .from(resources)
      .where(and(eq(resources.resourceType, "file"), ...(cursor ? [gt(resources.id, cursor)] : [])))
      .orderBy(asc(resources.id))
      .limit(batchSize);

    if (rows.length === 0) break;

    for (const resource of rows) {
      cursor = resource.id;
      checked++;
      if (!resource.storagePath || !resource.contentHash) {
        issues.push({
          resourceId: resource.id,
          storagePath: resource.storagePath ?? "",
          status: "error",
          error: "Resource is missing its storage path or recorded content hash",
        });
        continue;
      }

      try {
        const { buffer } = await downloadFile(resource.storagePath);
        const actualHash = hashFileResource(buffer, resource.title);
        if (actualHash !== resource.contentHash) {
          issues.push({
            resourceId: resource.id,
            storagePath: resource.storagePath,
            status: "mismatch",
            expectedHash: resource.contentHash,
            actualHash,
          });
        }
      } catch (error) {
        issues.push({
          resourceId: resource.id,
          storagePath: resource.storagePath,
          status: error instanceof StorageNotFoundError ? "missing" : "error",
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    if (rows.length < batchSize) break;
  }

  console.log(
    JSON.stringify(
      {
        mode: options.dryRun ? "dry-run" : "report-only",
        checked,
        nextAfter: cursor ?? null,
        issueCount: issues.length,
        issues,
      },
      null,
      2,
    ),
  );
  if (issues.length > 0) process.exitCode = 1;
}

try {
  await main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
} finally {
  await pgClient.end();
}
