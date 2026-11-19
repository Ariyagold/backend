/**
 * Purchase snapshots — freeze what was bought, and on what terms, onto the
 * payment row at purchase time so a receipt stays interpretable after the
 * resource's metadata, price or ownership changes.
 *
 * Compatibility policy for rows written before snapshots existed:
 *   - `receipt_version` is NULL on those rows; every new row gets
 *     RECEIPT_SNAPSHOT_VERSION.
 *   - Legacy rows are never back-filled from the *current* resource state —
 *     the resource may have been edited since, so a back-fill would fabricate
 *     terms the buyer never agreed to.
 *   - Receipts for legacy rows report `terms.legacy = true` with null content
 *     identity, network and asset. Only `amount`, the parties and `paidAt`
 *     (always recorded) are authoritative for them.
 */
import { config } from "../config.js";

/** Bump when the snapshot shape changes; readers switch on this value. */
export const RECEIPT_SNAPSHOT_VERSION = 1;

/** Settlement asset label recorded alongside the asset contract id. */
export const RECEIPT_ASSET_CODE = "USDC";

export interface SnapshotSource {
  title: string;
  resourceType: string;
  contentHash: string | null;
}

export interface PurchaseSnapshot {
  receiptVersion: number;
  network: string;
  asset: string;
  resourceTitle: string | null;
  resourceType: string | null;
  resourceContentHash: string | null;
}

/** Columns to spread into a `payments` insert for a new purchase. */
export function buildPurchaseSnapshot(resource: SnapshotSource | null): PurchaseSnapshot {
  return {
    receiptVersion: RECEIPT_SNAPSHOT_VERSION,
    network: config.NETWORK,
    asset: config.USDC_CONTRACT_ID,
    resourceTitle: resource?.title ?? null,
    resourceType: resource?.resourceType ?? null,
    resourceContentHash: resource?.contentHash ?? null,
  };
}

export interface StoredSnapshot {
  receiptVersion: number | null;
  network: string | null;
  asset: string | null;
  resourceTitle: string | null;
  resourceType: string | null;
  resourceContentHash: string | null;
}

export interface ReceiptTerms {
  version: number | null;
  /** True for rows recorded before snapshots existed (see policy above). */
  legacy: boolean;
  network: string | null;
  asset: { code: string; contract: string } | null;
  content: { title: string | null; type: string | null; contentHash: string | null } | null;
}

/** Render the stored snapshot for a receipt, applying the legacy policy. */
export function toReceiptTerms(row: StoredSnapshot): ReceiptTerms {
  if (row.receiptVersion == null) {
    return { version: null, legacy: true, network: null, asset: null, content: null };
  }
  return {
    version: row.receiptVersion,
    legacy: false,
    network: row.network,
    asset: row.asset ? { code: RECEIPT_ASSET_CODE, contract: row.asset } : null,
    content: {
      title: row.resourceTitle,
      type: row.resourceType,
      contentHash: row.resourceContentHash,
    },
  };
}
