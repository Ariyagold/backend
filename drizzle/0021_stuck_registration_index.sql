-- #169: cover the stale-registration query's filter (onchain_status +
-- onchain_pending_since) and its oldest-first, id-tiebroken ordering with a
-- single composite index.
CREATE INDEX IF NOT EXISTS "idx_resources_stuck_registration" ON "resources" ("onchain_status", "onchain_pending_since", "id");
