import type { Response } from "express";
import { createHash } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { db } from "../db/client.js";
import { payments } from "../db/schema.js";
import { getLogger } from "./logger.js";

/**
 * Tracks delivery independently of settlement (#194): "delivered" only once the
 * response fully finished, "aborted" if the connection closed first.
 */
export function recordDeliveryOnClose(res: Response, paymentId: string): void {
  res.once("close", () => {
    const deliveryStatus = res.writableFinished ? "delivered" : "aborted";
    Promise.resolve()
      .then(() => db.update(payments).set({ deliveryStatus }).where(eq(payments.id, paymentId)))
      .catch((err: unknown) => {
        getLogger().error(
          { event: "payment_delivery_update_failed", paymentId, deliveryStatus, err },
          "failed to record delivery status",
        );
      });
  });
}

/**
 * Resolves a payment row's settlement status once the response is sent (#99).
 *
 * @x402/express verifies the payment before the handler runs but settles it
 * only after the handler responds; when settlement fails it discards the
 * buffered response and sends an error status instead. The facilitator's
 * outcome is exposed in the X-PAYMENT-RESPONSE header, which is the
 * authoritative source (#190); the status code is only a fallback.
 */

export type SettlementOutcome = {
  status: "settled" | "failed";
  txHash: string | null;
  network: string | null;
  failureReason: string | null;
};

/** Stable settlement identity: hash of the payment authorization header (#192). */
export function settlementKeyFromHeader(header: unknown): string | null {
  if (typeof header !== "string" || header.length === 0) return null;
  return createHash("sha256").update(header).digest("hex");
}

const REASON_RE = /^[a-z0-9_]{1,64}$/;

/** Extracts the settlement outcome; never returns authorization material. */
export function readSettlementOutcome(res: Response): SettlementOutcome {
  const raw = res.getHeader("x-payment-response");
  if (typeof raw === "string") {
    try {
      const parsed = JSON.parse(Buffer.from(raw, "base64").toString("utf8")) as Record<string, unknown>;
      const ok = parsed.success === true;
      const tx = parsed.transaction ?? parsed.txHash;
      const reason = typeof parsed.errorReason === "string" && REASON_RE.test(parsed.errorReason)
        ? parsed.errorReason
        : "settlement_rejected";
      return {
        status: ok ? "settled" : "failed",
        txHash: ok && typeof tx === "string" && tx.length > 0 ? tx.slice(0, 128) : null,
        network: typeof parsed.network === "string" ? parsed.network.slice(0, 64) : null,
        failureReason: ok ? null : reason,
      };
    } catch {
      // fall through to status-code inference
    }
  }
  const ok = res.statusCode < 400;
  return {
    status: ok ? "settled" : "failed",
    txHash: null,
    network: null,
    failureReason: ok ? null : `http_${res.statusCode}`,
  };
}

/**
 * Atomically moves a pending payment to a terminal status. Returns the row
 * only for the call that performed the transition, so callers can emit
 * success side effects exactly once.
 */
export async function applySettlement(paymentId: string, outcome: SettlementOutcome) {
  const [row] = await db
    .update(payments)
    .set({
      status: outcome.status,
      settlementTxHash: outcome.txHash,
      settlementNetwork: outcome.network,
      settlementFailureReason: outcome.failureReason,
      settledAt: outcome.status === "settled" ? new Date() : null,
    })
    .where(and(eq(payments.id, paymentId), eq(payments.status, "pending")))
    .returning();
  return row ?? null;
}

const RETRY_DELAYS_MS = [0, 500, 2_000];

export function recordSettlementOnFinish(
  res: Response,
  paymentId: string,
  onSettled?: (payment: typeof payments.$inferSelect) => void,
): void {
  res.once("finish", () => {
    const outcome = readSettlementOutcome(res);
    void (async () => {
      for (let i = 0; i < RETRY_DELAYS_MS.length; i++) {
        if (RETRY_DELAYS_MS[i]) await new Promise((r) => setTimeout(r, RETRY_DELAYS_MS[i]));
        try {
          const row = await applySettlement(paymentId, outcome);
          if (row && outcome.status === "settled") onSettled?.(row);
          return;
        } catch (err) {
          getLogger().error(
            { event: "payment_settlement_update_failed", paymentId, status: outcome.status, attempt: i + 1, err },
            "failed to record payment settlement status",
          );
        }
      }
      // Left pending; the reconciliation worker resolves it (#191).
    })();
  });
}
