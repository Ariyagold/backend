import { db } from './db';

/**
 * Shared catalog cache-version token.
 *
 * The token lives in the database so that every backend replica observes the
 * same value. Mutations bump the token; readers compare the token they last
 * cached against the current one to decide whether their local caches are
 * stale. This provides cross-replica invalidation without a message bus.
 *
 * Reads are memoized locally for a short window (MEMO_TTL_MS) so that we do
 * not hit the database on every request. The memo window bounds the freshness
 * guarantee: after a remote mutation, other replicas observe the new token
 * within MEMO_TTL_MS.
 */

/** How long a fetched version token is trusted locally before re-reading. */
export const MEMO_TTL_MS = 1000;

/** Key used to store the catalog version token in the shared store. */
const CATALOG_VERSION_KEY = 'catalog_version';

interface MemoizedVersion {
  value: number;
  fetchedAt: number;
}

let memo: MemoizedVersion | null = null;

/**
 * Minimal shape of the shared key/value store used for the version token.
 * Implemented on top of the existing `db` client.
 */
interface VersionRow {
  value: string | number | null;
}

/**
 * Read the current catalog version token from the database.
 * Falls back to 0 when the token has never been written.
 */
async function readVersionFromDb(): Promise<number> {
  const row = await db.get<VersionRow>(
    'SELECT value FROM app_settings WHERE key = ?',
    [CATALOG_VERSION_KEY],
  );

  if (!row || row.value === null || row.value === undefined) {
    return 0;
  }

  const parsed = Number(row.value);
  return Number.isFinite(parsed) ? parsed : 0;
}

/**
 * Persist a new catalog version token to the database.
 */
async function writeVersionToDb(value: number): Promise<void> {
  await db.run(
    `INSERT INTO app_settings (key, value)
     VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    [CATALOG_VERSION_KEY, String(value)],
  );
}

/**
 * Return the current shared catalog version token.
 *
 * The value is memoized for MEMO_TTL_MS to avoid a database round-trip on
 * every request. Callers that need a guaranteed-fresh value can pass
 * `{ force: true }` to bypass the memo.
 */
export async function getCatalogVersion(
  options: { force?: boolean } = {},
): Promise<number> {
  const now = Date.now();

  if (!options.force && memo && now - memo.fetchedAt < MEMO_TTL_MS) {
    return memo.value;
  }

  const value = await readVersionFromDb();
  memo = { value, fetchedAt: now };
  return value;
}

/**
 * Bump the shared catalog version token and return the new value.
 *
 * Every replica that reads the token afterwards will observe a value
 * different from the one it previously cached, and can invalidate its local
 * caches accordingly. The local memo is updated immediately so the bumping
 * replica does not need to re-read the database.
 */
export async function bumpCatalogVersion(): Promise<number> {
  const current = await readVersionFromDb();
  const next = current + 1;

  await writeVersionToDb(next);

  memo = { value: next, fetchedAt: Date.now() };
  return next;
}

/**
 * Clear the local memo. Intended for tests and for callers that want the next
 * read to hit the database.
 */
export function resetCatalogVersionMemo(): void {
  memo = null;
}