ALTER TYPE "verification_status" ADD VALUE IF NOT EXISTS 'review_required';
--> statement-breakpoint
ALTER TABLE "verifications" ADD COLUMN IF NOT EXISTS "input_contract_version" text;
