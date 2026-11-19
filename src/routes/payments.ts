import { Router, type Router as RouterType } from "express";
import { eq, desc } from "drizzle-orm";
import { Keypair } from "@stellar/stellar-sdk";
import { db } from "../db/client.js";
import { payments, publishers } from "../db/schema.js";
import { AppError } from "../lib/errors.js";
import { hashApiKey } from "../utils/crypto.js";
import { noStore } from "../middleware/security.js";
import {
  buildWalletAuthMessageV1,
  buildWalletAuthMessageV2,
  rawQueryFromUrl,
} from "../utils/walletAuth.js";

const router: RouterType = Router();
const WALLET_SIGNATURE_MAX_AGE_SECONDS = 300;

function verifyWalletSignature(req: import("express").Request, address: string): boolean {
  const timestamp = req.headers["x-wallet-timestamp"];
  const signature = req.headers["x-wallet-signature"];
  if (typeof timestamp !== "string" || !/^\d+$/.test(timestamp) || typeof signature !== "string") {
    return false;
  }

  const timestampSeconds = Number(timestamp);
  if (
    !Number.isSafeInteger(timestampSeconds) ||
    Math.abs(Date.now() / 1000 - timestampSeconds) > WALLET_SIGNATURE_MAX_AGE_SECONDS
  ) {
    return false;
  }

  try {
    const signatureBytes = Buffer.from(signature, "base64");
    if (signatureBytes.length !== 64 || signatureBytes.toString("base64") !== signature) return false;
    const keypair = Keypair.fromPublicKey(address);
    const rawQuery = rawQueryFromUrl(req.originalUrl);
    const v2 = buildWalletAuthMessageV2({ method: req.method, path: req.path, rawQuery, timestamp });
    if (keypair.verify(Buffer.from(v2, "utf8"), signatureBytes)) return true;

    // Legacy v1 messages do not bind the query string, so they are only
    // accepted for requests that have none (see docs/wallet-auth.md).
    if (rawQuery !== "") return false;
    const v1 = buildWalletAuthMessageV1({ method: req.method, path: req.path, timestamp });
    return keypair.verify(Buffer.from(v1, "utf8"), signatureBytes);
  } catch {
    return false;
  }
}

async function findPublisherForApiKey(key: string) {
  return db
    .select({ walletAddress: publishers.walletAddress })
    .from(publishers)
    .where(eq(publishers.apiKeyHash, hashApiKey(key)))
    .then((rows) => rows[0] ?? null);
}

// Private financial responses are never cached by browsers or shared proxies
// (see noStore in middleware/security.ts).

// GET /payments/:id/receipt — payment receipt endpoint
router.get("/payments/:id/receipt", noStore, async (req, res) => {
  const walletAddressHeader = req.headers["x-wallet-address"];
  const walletAddress = typeof walletAddressHeader === "string" ? walletAddressHeader : undefined;
  const walletAuthorized = walletAddress !== undefined && verifyWalletSignature(req, walletAddress);
  const apiKey = req.headers["x-api-key"];
  const apiKeyPublisher = typeof apiKey === "string" ? await findPublisherForApiKey(apiKey) : null;

  if (!walletAuthorized && !apiKeyPublisher) {
    throw new AppError("UNAUTHORIZED", "Valid wallet signature or publisher API key required");
  }

  const id = req.params.id as string;
  const payment = await db
    .select({
      id: payments.id,
      resourceId: payments.resourceId,
      amount: payments.amount,
      payerAddress: payments.payerAddress,
      recipientAddress: payments.recipientAddress,
      paidAt: payments.paidAt,
    })
    .from(payments)
    .where(eq(payments.id, id))
    .then((rows) => rows[0] ?? null);

  if (!payment) {
    throw new AppError("NOT_FOUND", "Receipt not found");
  }

  const isPayer = walletAuthorized && walletAddress === payment.payerAddress;
  const isRecipientPublisher = apiKeyPublisher?.walletAddress === payment.recipientAddress;
  if (!isPayer && !isRecipientPublisher) {
    throw new AppError("FORBIDDEN", "This receipt is not available to this caller");
  }

  res.json(payment);
});

// GET /buyers/:address/payments — buyer payment history
router.get("/buyers/:address/payments", noStore, async (req, res) => {
  const address = req.params.address as string;
  if (!verifyWalletSignature(req, address)) {
    throw new AppError("UNAUTHORIZED", "Valid wallet signature required");
  }

  const buyerPayments = await db
    .select({
      id: payments.id,
      resourceId: payments.resourceId,
      amount: payments.amount,
      payerAddress: payments.payerAddress,
      recipientAddress: payments.recipientAddress,
      paidAt: payments.paidAt,
    })
    .from(payments)
    .where(eq(payments.payerAddress, address))
    .orderBy(desc(payments.paidAt));

  res.json(buyerPayments);
});

export default router;
