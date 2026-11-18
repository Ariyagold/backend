import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { Pool } from 'pg';
import * as schema from './schema';

const connectionString = process.env.DATABASE_URL;

if (!connectionString) {
  throw new Error('DATABASE_URL is not set');
}

const pool = new Pool({ connectionString });

export const db = drizzle(pool, { schema });

/**
 * Run the journal-aware Drizzle migrator against the configured database.
 *
 * Drizzle tracks applied migrations in its journal table, so running this
 * more than once is safe (already-applied migrations are skipped). Any
 * failure is propagated to the caller so deployment can stop on error.
 */
export async function runMigrations(): Promise<void> {
  await migrate(db, { migrationsFolder: './drizzle' });
}

if (require.main === module) {
  runMigrations()
    .then(async () => {
      await pool.end();
      process.exit(0);
    })
    .catch(async (error) => {
      console.error('Migration failed:', error);
      await pool.end().catch(() => undefined);
      process.exit(1);
    });
}
