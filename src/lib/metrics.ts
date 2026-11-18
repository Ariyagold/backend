import { collectDefaultMetrics, Counter, Gauge, Histogram, Registry } from "prom-client";

export const metricsRegistry = new Registry();

collectDefaultMetrics({ register: metricsRegistry });

// DB pool
export const dbPoolTotal = new Gauge({
  name: "db_pool_connections_max",
  help: "Configured maximum database connections in the pool",
  registers: [metricsRegistry],
});

// HTTP request duration
export const httpRequestDuration = new Histogram({
  name: "http_request_duration_seconds",
  help: "HTTP request duration in seconds",
  labelNames: ["method", "route", "status_code"] as const,
  buckets: [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
  registers: [metricsRegistry],
});

// HTTP errors
export const httpErrorsTotal = new Counter({
  name: "http_errors_total",
  help: "Total HTTP errors",
  labelNames: ["method", "route", "status_code"] as const,
  registers: [metricsRegistry],
});

// Business events
export const businessEventsTotal = new Counter({
  name: "business_events_total",
  help: "Total business events",
  labelNames: ["event", "outcome"] as const,
  registers: [metricsRegistry],
});

// Estimated AI verification spend (USD), from OpenRouter token usage.
export const verificationCostUsd = new Counter({
  name: "verification_cost_usd_total",
  help: "Estimated cumulative cost of AI content verification in USD",
  registers: [metricsRegistry],
});

// Rate-limit rejections
export const rateLimitCounter = new Counter({
  name: "http_rate_limit_rejections_total",
  help: "Total requests rejected by rate limiting",
  labelNames: ["limiter"] as const,
  registers: [metricsRegistry],
});

// Cache hits/misses
export const cacheHits = new Counter({
  name: "cache_hits_total",
  help: "Total cache hits",
  labelNames: ["cache"] as const,
  registers: [metricsRegistry],
});

export const cacheMisses = new Counter({
  name: "cache_misses_total",
  help: "Total cache misses",
  labelNames: ["cache"] as const,
  registers: [metricsRegistry],
});

// Webhook Outbox Metrics (#158)
// Operational measurements specifically for persistent delivery health.
// Note: Intentionally exported without publisher-ID labels to prevent high cardinality.
export const webhookOutboxPendingCount = new Gauge({
  name: "webhook_outbox_pending_count",
  help: "Number of pending webhook outbox rows awaiting delivery",
  registers: [metricsRegistry],
});

export const webhookOutboxOldestDueAgeSeconds = new Gauge({
  name: "webhook_outbox_oldest_due_age_seconds",
  help: "Age in seconds of the oldest due pending webhook outbox delivery",
  registers: [metricsRegistry],
});

export const webhookOutboxExhaustedTotal = new Counter({
  name: "webhook_outbox_exhausted_total",
  help: "Total webhook outbox deliveries that exhausted all retry attempts (terminal failures)",
  registers: [metricsRegistry],
});

/**
 * Example Prometheus Alert Rules for Webhook Outbox (#158):
 *
 * 1. Sustained Backlog Alert:
 * ```yaml
 * - alert: WebhookOutboxSustainedBacklog
 *   expr: webhook_outbox_oldest_due_age_seconds > 300
 *   for: 5m
 *   labels:
 *     severity: warning
 *   annotations:
 *     summary: Webhook outbox has pending deliveries older than 5 minutes
 *     description: Oldest due webhook outbox event has been pending for {{ $value }}s.
 * ```
 *
 * 2. Terminal Failure Rate Alert:
 * ```yaml
 * - alert: WebhookOutboxTerminalFailuresElevated
 *   expr: rate(webhook_outbox_exhausted_total[5m]) > 0.05
 *   for: 5m
 *   labels:
 *     severity: critical
 *   annotations:
 *     summary: High rate of webhook deliveries exhausting maximum retry attempts
 *     description: Webhook terminal failure rate is {{ $value }} failures/sec over 5m.
 * ```
 */
