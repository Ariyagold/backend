ALTER TABLE "pending_cleanup"
  ADD COLUMN IF NOT EXISTS "next_attempt_at" timestamptz NOT NULL DEFAULT now();
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_pending_cleanup_next_attempt"
  ON "pending_cleanup" ("next_attempt_at", "created_at");
