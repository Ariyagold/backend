/**
 * SynapsVault — Admin Routes
 * Protected by X-Admin-Key header. Never expose to the public internet
 * without an additional layer (VPN / IP whitelist recommended).
 */
import { createHash, timingSafeEqual } from "node:crypto";
import { Router, type NextFunction, type Request, type Response } from "express";
import { db } from "../db/client.js";
import { resources, publishers, payments } from "../db/schema.js";
import { desc, count, and, eq, gte, lte, type SQL } from "drizzle-orm";
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

export default router;
