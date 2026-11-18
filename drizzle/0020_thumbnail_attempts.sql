-- #167: track thumbnail retry attempts so transient storage faults can be
-- retried while corrupt/unsupported image data still fails immediately.
-- Idempotent so databases patched by hand are safe.
ALTER TABLE "resources" ADD COLUMN IF NOT EXISTS "thumbnail_attempts" integer NOT NULL DEFAULT 0;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "resources" ADD CONSTRAINT "resources_thumbnail_attempts_nonneg" CHECK ("thumbnail_attempts" >= 0);
EXCEPTION WHEN duplicate_object THEN null;
END $$;
