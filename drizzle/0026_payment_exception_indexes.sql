-- Indexes backing GET /admin/payments/exceptions (settlement / delivery
-- reconciliation filters, oldest-first).
CREATE INDEX IF NOT EXISTS "idx_payments_status_paid_at"
  ON "payments" ("status", "paid_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_payments_delivery_status_paid_at"
  ON "payments" ("delivery_status", "paid_at");
