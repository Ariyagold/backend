import { z } from "zod/v4";

/** Webhook event types a publisher can subscribe to. */
export const webhookEventValues = [
  "resource.purchased",
  "resource.listed",
  "resource.delisted",
  "payment.received",
] as const;

export type WebhookEvent = (typeof webhookEventValues)[number];

export const allWebhookEventValues = [
  ...webhookEventValues,
  "webhook.test",
] as const;

export type AllWebhookEvent = (typeof allWebhookEventValues)[number];

/** Current canonical webhook payload version (#159). */
export const CURRENT_WEBHOOK_VERSION = "2026-01-01";

/**
 * Webhook Compatibility Rules (#159):
 * 1. Payload Version: Indicated by the top-level `version` field (e.g. "2026-01-01").
 * 2. Forward Compatibility: Receivers must ignore unrecognized fields. New fields may be added without changing the version.
 * 3. Breaking Changes: Modifications to existing field types, semantics, or removals will result in a new version identifier.
 * 4. Timestamps: ISO-8601 UTC strings.
 */
export const webhookPayloadSchema = z.object({
  version: z.string().default(CURRENT_WEBHOOK_VERSION),
  event: z.enum(allWebhookEventValues),
  timestamp: z.string().datetime(),
  data: z.record(z.string(), z.unknown()),
});

export type WebhookPayloadEnvelope = z.infer<typeof webhookPayloadSchema>;

/**
 * Event-specific example fixtures published for receivers and integration testing (#159).
 */
export const webhookFixtures: Record<AllWebhookEvent, WebhookPayloadEnvelope> = {
  "resource.purchased": {
    version: CURRENT_WEBHOOK_VERSION,
    event: "resource.purchased",
    timestamp: "2026-01-01T00:00:00.000Z",
    data: {
      resourceId: "res_abc123",
      buyerAddress: "GBUYER1234567890ABCDEFGHIJKLMNOPQRSTUVWXYZ",
      paymentId: "pay_xyz789",
      amount: "5.0000000",
    },
  },
  "resource.listed": {
    version: CURRENT_WEBHOOK_VERSION,
    event: "resource.listed",
    timestamp: "2026-01-01T00:00:00.000Z",
    data: {
      resourceId: "res_abc123",
      title: "Sample Machine Learning Model Weights",
      price: "10.0000000",
    },
  },
  "resource.delisted": {
    version: CURRENT_WEBHOOK_VERSION,
    event: "resource.delisted",
    timestamp: "2026-01-01T00:00:00.000Z",
    data: {
      resourceId: "res_abc123",
      reason: "Requested by publisher",
    },
  },
  "payment.received": {
    version: CURRENT_WEBHOOK_VERSION,
    event: "payment.received",
    timestamp: "2026-01-01T00:00:00.000Z",
    data: {
      paymentId: "pay_xyz789",
      resourceId: "res_abc123",
      payerAddress: "GPAID1234567890ABCDEFGHIJKLMNOPQRSTUVWXYZ",
      amount: "5.0000000",
    },
  },
  "webhook.test": {
    version: CURRENT_WEBHOOK_VERSION,
    event: "webhook.test",
    timestamp: "2026-01-01T00:00:00.000Z",
    data: {
      publisherId: "pub_123456",
    },
  },
};

/** Validates that all defined fixtures conform to the runtime schema (#159). */
for (const fixture of Object.values(webhookFixtures)) {
  webhookPayloadSchema.parse(fixture);
}
