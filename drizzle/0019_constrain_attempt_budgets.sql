-- #177: enforce nonnegative attempt counters and a positive webhook delivery
-- budget in Postgres, so retry-state assumptions hold regardless of caller.
-- Every statement is idempotent so databases patched by hand are safe.

-- Preflight: report historical rows that violate the constraints we're about
-- to add, before they get silently repaired below.
DO $$
DECLARE
  bad_onchain_attempts int;
  bad_cleanup_attempts int;
  bad_failed_event_attempts int;
  bad_outbox_attempts int;
  bad_outbox_max_attempts int;
BEGIN
  SELECT count(*) INTO bad_onchain_attempts FROM "resources" WHERE "onchain_attempts" < 0;
  SELECT count(*) INTO bad_cleanup_attempts FROM "pending_cleanup" WHERE "attempts" < 0;
  SELECT count(*) INTO bad_failed_event_attempts FROM "failed_events" WHERE "attempts" < 0;
  SELECT count(*) INTO bad_outbox_attempts FROM "webhook_outbox" WHERE "attempts" < 0;
  SELECT count(*) INTO bad_outbox_max_attempts FROM "webhook_outbox" WHERE "max_attempts" <= 0;

  IF bad_onchain_attempts > 0 OR bad_cleanup_attempts > 0 OR bad_failed_event_attempts > 0
    OR bad_outbox_attempts > 0 OR bad_outbox_max_attempts > 0 THEN
    RAISE NOTICE 'attempt-budget preflight: repairing % negative resources.onchain_attempts, % negative pending_cleanup.attempts, % negative failed_events.attempts, % negative webhook_outbox.attempts, % nonpositive webhook_outbox.max_attempts',
      bad_onchain_attempts, bad_cleanup_attempts, bad_failed_event_attempts, bad_outbox_attempts, bad_outbox_max_attempts;
  END IF;
END $$;
--> statement-breakpoint

-- Repair: clamp negative counters to zero and nonpositive delivery budgets
-- to the column default, so the constraints below validate against existing
-- data instead of failing the migration.
UPDATE "resources" SET "onchain_attempts" = 0 WHERE "onchain_attempts" < 0;
--> statement-breakpoint
UPDATE "pending_cleanup" SET "attempts" = 0 WHERE "attempts" < 0;
--> statement-breakpoint
UPDATE "failed_events" SET "attempts" = 0 WHERE "attempts" < 0;
--> statement-breakpoint
UPDATE "webhook_outbox" SET "attempts" = 0 WHERE "attempts" < 0;
--> statement-breakpoint
UPDATE "webhook_outbox" SET "max_attempts" = 3 WHERE "max_attempts" <= 0;
--> statement-breakpoint

DO $$ BEGIN
  ALTER TABLE "resources" ADD CONSTRAINT "resources_onchain_attempts_nonneg" CHECK ("onchain_attempts" >= 0);
EXCEPTION WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "pending_cleanup" ADD CONSTRAINT "pending_cleanup_attempts_nonneg" CHECK ("attempts" >= 0);
EXCEPTION WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "failed_events" ADD CONSTRAINT "failed_events_attempts_nonneg" CHECK ("attempts" >= 0);
EXCEPTION WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "webhook_outbox" ADD CONSTRAINT "webhook_outbox_attempts_nonneg" CHECK ("attempts" >= 0);
EXCEPTION WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "webhook_outbox" ADD CONSTRAINT "webhook_outbox_max_attempts_positive" CHECK ("max_attempts" > 0);
EXCEPTION WHEN duplicate_object THEN null;
END $$;
