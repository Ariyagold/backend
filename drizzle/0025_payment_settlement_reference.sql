ALTER TABLE "payments" ADD COLUMN "settlement_key" text;--> statement-breakpoint
ALTER TABLE "payments" ADD COLUMN "settlement_tx_hash" text;--> statement-breakpoint
ALTER TABLE "payments" ADD COLUMN "settlement_network" text;--> statement-breakpoint
ALTER TABLE "payments" ADD COLUMN "settlement_failure_reason" text;--> statement-breakpoint
ALTER TABLE "payments" ADD COLUMN "settled_at" timestamp with time zone;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_payments_settlement_key" ON "payments" USING btree ("settlement_key");--> statement-breakpoint
CREATE INDEX "idx_payments_pending_paid_at" ON "payments" USING btree ("paid_at") WHERE "status" = 'pending';
