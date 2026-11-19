import { describe, it, expect, vi } from "vitest";

vi.mock("../config.js", () => ({
  config: { NETWORK: "stellar:testnet", USDC_CONTRACT_ID: "CUSDCCONTRACT" },
}));

import { buildPurchaseSnapshot, RECEIPT_SNAPSHOT_VERSION, toReceiptTerms } from "./purchaseSnapshot.js";

describe("buildPurchaseSnapshot", () => {
  it("captures content identity, network and asset at purchase time", () => {
    const resource = { title: "Dataset", resourceType: "file", contentHash: "abc123" };
    const snap = buildPurchaseSnapshot(resource);
    expect(snap).toEqual({
      receiptVersion: RECEIPT_SNAPSHOT_VERSION,
      network: "stellar:testnet",
      asset: "CUSDCCONTRACT",
      resourceTitle: "Dataset",
      resourceType: "file",
      resourceContentHash: "abc123",
    });

    // Mutating the resource afterwards must not change the stored snapshot.
    resource.title = "Renamed";
    resource.contentHash = "changed";
    expect(snap.resourceTitle).toBe("Dataset");
    expect(snap.resourceContentHash).toBe("abc123");
  });

  it("still records network and asset when no resource is attached", () => {
    const snap = buildPurchaseSnapshot(null);
    expect(snap.receiptVersion).toBe(RECEIPT_SNAPSHOT_VERSION);
    expect(snap.network).toBe("stellar:testnet");
    expect(snap.resourceContentHash).toBeNull();
  });
});

describe("toReceiptTerms", () => {
  it("flags legacy rows (no receipt_version) instead of inventing terms", () => {
    expect(
      toReceiptTerms({
        receiptVersion: null,
        network: null,
        asset: null,
        resourceTitle: null,
        resourceType: null,
        resourceContentHash: null,
      }),
    ).toEqual({ version: null, legacy: true, network: null, asset: null, content: null });
  });

  it("renders snapshotted terms for versioned rows", () => {
    expect(
      toReceiptTerms({
        receiptVersion: 1,
        network: "stellar:pubnet",
        asset: "CUSDC",
        resourceTitle: "T",
        resourceType: "link",
        resourceContentHash: "h",
      }),
    ).toEqual({
      version: 1,
      legacy: false,
      network: "stellar:pubnet",
      asset: { code: "USDC", contract: "CUSDC" },
      content: { title: "T", type: "link", contentHash: "h" },
    });
  });
});
