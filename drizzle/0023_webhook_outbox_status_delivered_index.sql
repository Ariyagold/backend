CREATE INDEX IF NOT EXISTS "idx_webhook_outbox_status_delivered"
  ON "webhook_outbox" ("status", "delivered_at");
