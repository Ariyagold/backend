/**
 * SynapsVault — Admin Routes
 * Protected by X-Admin-Key header. Never expose to the public internet
 * without an additional layer (VPN / IP whitelist recommended).
 */
import { createHash, timingSafeEqual } from "node:crypto";
import { Router, type NextFunction, type Request, type Response } from "express";
import { db } from "../db/client.js";
import { resources, publishers, payments } from "../db/schema.js";
import { desc, asc, count, and, or, eq, ne, gte, lte, inArray, sql, type SQL } from "drizzle-orm";
import { getLogger } from "../lib/logger.js";
import { AppError } from "../lib/errors.js";
import { adminDelistResource, listVerificationReviewQueue, resolveVerificationReview } from "../services/resourceService.js";
import { config } from "../config.js";

const router = Router();

function digest(value: string): Buffer {
  return createHash("sha256").update(value).digest();
}

/** Constant-time check of X-Admin-Key against ADMIN_API_KEY (disabled when unset). */
function adminAuth(req: Request, _res: Response, next: NextFunction) {
  const expected = config.ADMIN_API_KEY;
  const key = req.headers["x-admin-key"];
  if (!expected || typeof key !== "string" || !timingSafeEqual(digest(key), digest(expected))) {
    throw new AppError("UNAUTHORIZED", "Unauthorized");
  }
  next();
}

/** GET /admin/stats */
router.get("/admin/stats", adminAuth, async (_req, res) => {
  const [[totalResources], [totalPublishers], [totalPayments]] = await Promise.all([
    db.select({ count: count() }).from(resources),
    db.select({ count: count() }).from(publishers),
    db.select({ count: count() }).from(payments),
  ]);

  res.json({
    resources:  totalResources.count,
    publishers: totalPublishers.count,
    payments:   totalPayments.count,
    uptime:     process.uptime(),
    timestamp:  new Date().toISOString(),
  });
});

/** POST /admin/delist/:id */
router.post("/admin/delist/:id", adminAuth, async (req, res) => {
  const id = req.params.id as string;
  const reason = typeof req.body?.reason === "string" ? req.body.reason.trim() || undefined : undefined;
  // Use a digest of the admin key as the actor identifier so the audit log
  // is attributable without storing the raw key.
  const rawKey = req.headers["x-admin-key"] as string;
  const actor = `admin:${createHash("sha256").update(rawKey).digest("hex").slice(0, 12)}`;
  const resource = await adminDelistResource(id, { reason, actor });
  if (!resource) {
    throw new AppError("NOT_FOUND", "Resource not found");
  }
  getLogger().warn({ resourceId: id, event: "admin_delist", actor, reason }, "resource delisted by admin");
  res.json({ success: true, id, delistedAt: new Date().toISOString() });
});

function adminActor(req: Request): string {
  const rawKey = req.headers["x-admin-key"] as string;
  return `admin:${createHash("sha256").update(rawKey).digest("hex").slice(0, 12)}`;
}

/** GET /admin/verification-reviews — queue of low-confidence holds (#188) */
router.get("/admin/verification-reviews", adminAuth, async (req, res) => {
  const limit = Math.min(Math.max(Math.trunc(Number(req.query.limit)) || 50, 1), 200);
  const page = Math.max(Math.trunc(Number(req.query.page)) || 1, 1);
  const entries = await listVerificationReviewQueue(limit, (page - 1) * limit);
  res.json({ page, limit, entries });
});

/** POST /admin/verification-reviews/:id/resolve — body { decision, reason } (#188) */
router.post("/admin/verification-reviews/:id/resolve", adminAuth, async (req, res) => {
  const id = req.params.id as string;
  const decision = req.body?.decision;
  const reason = typeof req.body?.reason === "string" ? req.body.reason.trim() : "";
  if (decision !== "approve" && decision !== "reject") {
    throw new AppError("VALIDATION_ERROR", "decision must be 'approve' or 'reject'");
  }
  if (!reason) throw new AppError("VALIDATION_ERROR", "reason is required");
  const actor = adminActor(req);
  const result = await resolveVerificationReview(id, { decision, reason, actor });
  if (!result.ok) {
    if (result.error === "not_found") throw new AppError("NOT_FOUND", "Resource not found");
    if (result.error === "delisted") {
      throw new AppError("FORBIDDEN", "Resource was delisted by an administrator and cannot be relisted");
    }
    throw new AppError("CONFLICT", "Resource is not awaiting verification review");
  }
  getLogger().info({ resourceId: id, event: "verification_review_resolved", actor, decision, reason }, "verification review resolved");
  res.json({ success: true, id, status: result.status });
});

/** Parse an optional ISO date query param; throws VALIDATION_ERROR when invalid. */
function parseDateParam(value: unknown, name: string): Date | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string") {
    throw new AppError("VALIDATION_ERROR", `Invalid ${name} date`);
  }
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw new AppError("VALIDATION_ERROR", `Invalid ${name} date`);
  }
  return parsed;
}

/** GET /admin/audit */
router.get("/admin/audit", adminAuth, async (req, res) => {
  const limit = Math.min(Math.max(Math.trunc(Number(req.query.limit)) || 50, 1), 200);
  const page  = Math.max(Math.trunc(Number(req.query.page)) || 1, 1);
  const offset = (page - 1) * limit;

  const resourceId = typeof req.query.resourceId === "string" && req.query.resourceId !== ""
    ? req.query.resourceId
    : undefined;
  const payer = typeof req.query.payer === "string" && req.query.payer !== ""
    ? req.query.payer
    : undefined;
  const from = parseDateParam(req.query.from, "from");
  const to = parseDateParam(req.query.to, "to");

  const conditions: SQL[] = [];
  if (resourceId !== undefined) conditions.push(eq(payments.resourceId, resourceId));
  if (payer !== undefined) conditions.push(eq(payments.payerAddress, payer));
  if (from !== undefined) conditions.push(gte(payments.paidAt, from));
  if (to !== undefined) conditions.push(lte(payments.paidAt, to));

  const rows = await db
    .select({ id: payments.id, resourceId: payments.resourceId,
              payer: payments.payerAddress, amount: payments.amount, paidAt: payments.paidAt })
    .from(payments)
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .orderBy(desc(payments.paidAt))
    .limit(limit)
    .offset(offset);

  res.json({ page, limit, entries: rows });
});

// ── Payment exceptions (settlement / delivery reconciliation) ───────────────

const SETTLEMENT_STATES = ["pending", "settled", "failed"] as const;
const DELIVERY_STATES = ["delivered", "undelivered"] as const;
const EXCEPTION_MAX_LIMIT = 200;
/** Upper bound on minAgeMinutes (1 year) so the cutoff can't overflow. */
const MAX_AGE_MINUTES = 525_600;

/** Parse a comma-separated enum list; undefined when absent. */
function parseEnumList<T extends string>(value: unknown, allowed: readonly T[], name: string): T[] | undefined {
  if (value === undefined || value === "") return undefined;
  if (typeof value !== "string") throw new AppError("VALIDATION_ERROR", `Invalid ${name}`);
  const items = [...new Set(value.split(",").map((v) => v.trim()).filter(Boolean))];
  const bad = items.filter((v) => !(allowed as readonly string[]).includes(v));
  if (items.length === 0 || bad.length > 0) {
    throw new AppError("VALIDATION_ERROR", `Invalid ${name}: expected one or more of ${allowed.join(", ")}`);
  }
  return items as T[];
}

function parseMinAgeMinutes(value: unknown): number {
  if (value === undefined || value === "") return 0;
  if (typeof value !== "string" || !/^\d+$/.test(value) || Number(value) > MAX_AGE_MINUTES) {
    throw new AppError("VALIDATION_ERROR", `Invalid minAgeMinutes: expected an integer 0-${MAX_AGE_MINUTES}`);
  }
  return Number(value);
}

/**
 * GET /admin/payments/exceptions
 *
 * Reconciliation view of payments that need recovery. Filters:
 *   settlement     — comma list of pending|settled|failed
 *   delivery       — comma list of delivered|undelivered
 *   minAgeMinutes  — only rows paid at least this long ago (default 0)
 *   limit          — 1-200 (default 50); oldest first so the most overdue
 *                    rows are always inside the bound
 * With neither settlement nor delivery given, the default exception set is
 * "not settled OR undelivered". `summary` counts the *whole* matching set
 * (not just the returned page) so operators can size the backlog.
 */
router.get("/admin/payments/exceptions", adminAuth, async (req, res) => {
  const settlement = parseEnumList(req.query.settlement, SETTLEMENT_STATES, "settlement");
  const delivery = parseEnumList(req.query.delivery, DELIVERY_STATES, "delivery");
  const minAgeMinutes = parseMinAgeMinutes(req.query.minAgeMinutes);
  const limit = Math.min(Math.max(Math.trunc(Number(req.query.limit)) || 50, 1), EXCEPTION_MAX_LIMIT);

  const now = new Date();
  const cutoff = new Date(now.getTime() - minAgeMinutes * 60_000);

  const conditions: SQL[] = [lte(payments.paidAt, cutoff)];
  if (settlement) conditions.push(inArray(payments.status, settlement));
  if (delivery) conditions.push(inArray(payments.deliveryStatus, delivery));
  if (!settlement && !delivery) {
    conditions.push(or(ne(payments.status, "settled"), eq(payments.deliveryStatus, "undelivered"))!);
  }
  const where = and(...conditions);

  const [entries, [summaryRow]] = await Promise.all([
    db
      .select({
        id: payments.id,
        resourceId: payments.resourceId,
        payer: payments.payerAddress,
        recipient: payments.recipientAddress,
        amount: payments.amount,
        status: payments.status,
        deliveryStatus: payments.deliveryStatus,
        paidAt: payments.paidAt,
      })
      .from(payments)
      .where(where)
      .orderBy(asc(payments.paidAt), asc(payments.id))
      .limit(limit),
    db
      .select({
        total: sql<number>`count(*)::int`,
        pending: sql<number>`count(*) filter (where ${payments.status} = 'pending')::int`,
        settled: sql<number>`count(*) filter (where ${payments.status} = 'settled')::int`,
        failed: sql<number>`count(*) filter (where ${payments.status} = 'failed')::int`,
        delivered: sql<number>`count(*) filter (where ${payments.deliveryStatus} = 'delivered')::int`,
        undelivered: sql<number>`count(*) filter (where ${payments.deliveryStatus} = 'undelivered')::int`,
        under1h: sql<number>`count(*) filter (where ${payments.paidAt} > now() - interval '1 hour')::int`,
        from1hTo24h: sql<number>`count(*) filter (where ${payments.paidAt} <= now() - interval '1 hour' and ${payments.paidAt} > now() - interval '24 hours')::int`,
        from1dTo7d: sql<number>`count(*) filter (where ${payments.paidAt} <= now() - interval '24 hours' and ${payments.paidAt} > now() - interval '7 days')::int`,
        over7d: sql<number>`count(*) filter (where ${payments.paidAt} <= now() - interval '7 days')::int`,
        oldestPaidAt: sql<Date | string | null>`min(${payments.paidAt})`,
      })
      .from(payments)
      .where(where),
  ]);

  const s = summaryRow ?? {
    total: 0, pending: 0, settled: 0, failed: 0, delivered: 0, undelivered: 0,
    under1h: 0, from1hTo24h: 0, from1dTo7d: 0, over7d: 0, oldestPaidAt: null,
  };
  const oldest = s.oldestPaidAt ? new Date(s.oldestPaidAt) : null;
  const total = Number(s.total);

  res.json({
    filters: {
      settlement: settlement ?? null,
      delivery: delivery ?? null,
      minAgeMinutes,
      defaultExceptionSet: !settlement && !delivery,
    },
    limit,
    truncated: total > entries.length,
    entries: entries.map((e) => ({
      ...e,
      ageSeconds: Math.max(0, Math.floor((now.getTime() - new Date(e.paidAt).getTime()) / 1000)),
    })),
    summary: {
      total,
      bySettlement: { pending: Number(s.pending), settled: Number(s.settled), failed: Number(s.failed) },
      byDelivery: { delivered: Number(s.delivered), undelivered: Number(s.undelivered) },
      byAge: {
        under1h: Number(s.under1h),
        from1hTo24h: Number(s.from1hTo24h),
        from1dTo7d: Number(s.from1dTo7d),
        over7d: Number(s.over7d),
      },
      oldestPaidAt: oldest ? oldest.toISOString() : null,
      oldestAgeSeconds: oldest ? Math.max(0, Math.floor((now.getTime() - oldest.getTime()) / 1000)) : null,
    },
    generatedAt: now.toISOString(),
  });
});

export default router;
