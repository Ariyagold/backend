-- #178: give every timestamp column explicit UTC semantics by converting
-- `timestamp without time zone` to `timestamptz`.
--
-- Historical interpretation: every row written before this migration was
-- produced by Postgres `now()` (via `defaultNow()`) or the app's own
-- `new Date()` sent through postgres.js, on connections that run in the UTC
-- session timezone (the app never sets `timezone` and the hosting Postgres
-- defaults to UTC). A `timestamp without time zone` value therefore already
-- holds the correct UTC wall-clock reading for that instant, just without
-- the zone label attached. Converting with `AT TIME ZONE 'UTC'` reattaches
-- that label without shifting the clock value, so every historical instant
-- is preserved exactly; it would be wrong to use the bare cast
-- (`::timestamptz`, which assumes the *session's* zone) if this ever runs
-- against a non-UTC session.
--
-- Idempotent: only touches columns still typed `timestamp without time zone`.
DO $$
DECLARE
  col record;
  cols text[][] := ARRAY[
    ARRAY['publishers', 'api_key_revoked_at'],
    ARRAY['publishers', 'created_at'],
    ARRAY['resources', 'admin_delisted_at'],
    ARRAY['resources', 'onchain_pending_since'],
    ARRAY['resources', 'created_at'],
    ARRAY['pending_cleanup', 'created_at'],
    ARRAY['verifications', 'checked_at'],
    ARRAY['payments', 'paid_at'],
    ARRAY['failed_events', 'created_at'],
    ARRAY['ledger_checkpoints', 'updated_at'],
    ARRAY['moderation_events', 'created_at'],
    ARRAY['idempotency_records', 'expires_at'],
    ARRAY['webhook_outbox', 'next_attempt_at'],
    ARRAY['webhook_outbox', 'delivered_at'],
    ARRAY['webhook_outbox', 'created_at']
  ];
  pair text[];
BEGIN
  FOREACH pair SLICE 1 IN ARRAY cols LOOP
    SELECT table_name, column_name INTO col
    FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = pair[1] AND column_name = pair[2]
      AND data_type = 'timestamp without time zone';

    IF FOUND THEN
      EXECUTE format(
        'ALTER TABLE %I ALTER COLUMN %I TYPE timestamptz USING %I AT TIME ZONE ''UTC''',
        pair[1], pair[2], pair[2]
      );
    END IF;
  END LOOP;
END $$;
