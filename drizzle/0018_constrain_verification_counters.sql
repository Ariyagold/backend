-- #176: enforce confidence/token-count ranges in Postgres so maintenance
-- tools and future callers can't write invalid rows through the DB alone.
-- Every statement is idempotent so databases patched by hand are safe.

-- Preflight: report historical rows that violate the constraints we're about
-- to add, before they get silently clamped below.
DO $$
DECLARE
  bad_confidence int;
  bad_prompt_tokens int;
  bad_completion_tokens int;
  bad_total_tokens int;
BEGIN
  SELECT count(*) INTO bad_confidence FROM "verifications" WHERE "confidence" < 0 OR "confidence" > 1;
  SELECT count(*) INTO bad_prompt_tokens FROM "verifications" WHERE "prompt_tokens" < 0;
  SELECT count(*) INTO bad_completion_tokens FROM "verifications" WHERE "completion_tokens" < 0;
  SELECT count(*) INTO bad_total_tokens FROM "verifications" WHERE "total_tokens" < 0;

  IF bad_confidence > 0 OR bad_prompt_tokens > 0 OR bad_completion_tokens > 0 OR bad_total_tokens > 0 THEN
    RAISE NOTICE 'verifications preflight: clamping % out-of-range confidence, % negative prompt_tokens, % negative completion_tokens, % negative total_tokens',
      bad_confidence, bad_prompt_tokens, bad_completion_tokens, bad_total_tokens;
  END IF;
END $$;
--> statement-breakpoint

-- Repair: clamp historical rows into range so the constraints below can be
-- validated against existing data instead of failing the migration.
UPDATE "verifications" SET "confidence" = LEAST(1, GREATEST(0, "confidence")) WHERE "confidence" < 0 OR "confidence" > 1;
--> statement-breakpoint
UPDATE "verifications" SET "prompt_tokens" = 0 WHERE "prompt_tokens" < 0;
--> statement-breakpoint
UPDATE "verifications" SET "completion_tokens" = 0 WHERE "completion_tokens" < 0;
--> statement-breakpoint
UPDATE "verifications" SET "total_tokens" = 0 WHERE "total_tokens" < 0;
--> statement-breakpoint

DO $$ BEGIN
  ALTER TABLE "verifications" ADD CONSTRAINT "verifications_confidence_range" CHECK ("confidence" >= 0 AND "confidence" <= 1);
EXCEPTION WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "verifications" ADD CONSTRAINT "verifications_prompt_tokens_nonneg" CHECK ("prompt_tokens" IS NULL OR "prompt_tokens" >= 0);
EXCEPTION WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "verifications" ADD CONSTRAINT "verifications_completion_tokens_nonneg" CHECK ("completion_tokens" IS NULL OR "completion_tokens" >= 0);
EXCEPTION WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "verifications" ADD CONSTRAINT "verifications_total_tokens_nonneg" CHECK ("total_tokens" IS NULL OR "total_tokens" >= 0);
EXCEPTION WHEN duplicate_object THEN null;
END $$;
