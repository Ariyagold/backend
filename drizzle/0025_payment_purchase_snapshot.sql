-- Purchase snapshot columns (receipt terms frozen at purchase time).
-- Existing rows keep receipt_version = NULL: they are legacy receipts and are
-- deliberately NOT back-filled from current resource state, which may have
-- changed since the purchase.
ALTER TABLE "payments" ADD COLUMN IF NOT EXISTS "receipt_version" integer;
--> statement-breakpoint
ALTER TABLE "payments" ADD COLUMN IF NOT EXISTS "network" text;
--> statement-breakpoint
ALTER TABLE "payments" ADD COLUMN IF NOT EXISTS "asset" text;
--> statement-breakpoint
ALTER TABLE "payments" ADD COLUMN IF NOT EXISTS "resource_title" text;
--> statement-breakpoint
ALTER TABLE "payments" ADD COLUMN IF NOT EXISTS "resource_type" text;
--> statement-breakpoint
ALTER TABLE "payments" ADD COLUMN IF NOT EXISTS "resource_content_hash" text;
