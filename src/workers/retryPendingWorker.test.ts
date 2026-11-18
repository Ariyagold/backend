import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
  select: vi.fn(), set: vi.fn(), returning: vi.fn(), remove: vi.fn(),
  exists: vi.fn(), register: vi.fn(), send: vi.fn(), poll: vi.fn(),
  deleteFile: vi.fn(), downloadFile: vi.fn(), uploadFile: vi.fn(),
  sharpToBuffer: vi.fn(),
}));
vi.mock("../db/client.js", () => ({ db: {
  select: m.select,
  update: () => ({ set: m.set }),
  delete: () => ({ where: m.remove }),
} }));
vi.mock("../services/registryClient.js", () => ({
  NETWORK_PASSPHRASE: "Test SDF Network ; September 2015",
  registryKeypair: { publicKey: () => "GREGISTRY" },
  registryClient: { register: m.register },
  resourceExists: m.exists,
  pollTransactionStatus: m.poll,
}));
vi.mock("../storage/supabaseStorage.js", () => ({
  deleteFile: m.deleteFile, downloadFile: m.downloadFile, uploadFile: m.uploadFile,
}));
vi.mock("sharp", () => ({
  default: () => ({
    resize: () => ({ jpeg: () => ({ toBuffer: () => m.sharpToBuffer() }) }),
  }),
}));
import { startRetryPendingWorker, stopRetryPendingWorker } from "./retryPendingWorker.js";

const orderByCalls: unknown[][] = [];
function batch(registrations: unknown[] = [], cleanup: unknown[] = [], thumbnails: unknown[] = []) {
  for (const rows of [registrations, cleanup, thumbnails]) {
    const chain = {
      where: () => chain,
      orderBy: (...args: unknown[]) => { orderByCalls.push(args); return chain; },
      limit: () => Promise.resolve(rows),
    };
    m.select.mockReturnValueOnce({ from: () => chain });
  }
}
const resource = { id: "res-1", walletAddress: "GREGISTRY", price: "1", title: "Test", contentHash: "hash", onchainTxHash: null };
async function start() {
  startRetryPendingWorker();
  await vi.advanceTimersByTimeAsync(0);
}
beforeEach(() => {
  vi.resetAllMocks();
  orderByCalls.length = 0;
  vi.useFakeTimers();
  m.returning.mockResolvedValue([{ onchainAttempts: 1 }]);
  m.set.mockImplementation(() => ({ where: () => Object.assign(Promise.resolve(), { returning: m.returning }) }));
  m.exists.mockResolvedValue(false);
  m.register.mockResolvedValue({ signAndSend: m.send });
  m.send.mockResolvedValue({ sendTransactionResponse: { hash: "tx-hash" } });
  m.sharpToBuffer.mockResolvedValue(Buffer.from("thumb"));
});
afterEach(() => {
  stopRetryPendingWorker();
  vi.useRealTimers();
});

describe("retryPendingWorker", () => {
  it("drains all three queues when no registrations are stuck", async () => {
    batch();
    await start();
    expect(m.select).toHaveBeenCalledTimes(3);
    expect(m.register).not.toHaveBeenCalled();
  });
  it("orders the stale-registration query oldest-pending-first with id as tiebreaker (#169)", async () => {
    batch();
    await start();
    // The first select is the stale-registration query; it orders by
    // pending-since then id, unlike the single-column cleanup ordering.
    expect(orderByCalls[0]).toHaveLength(2);
  });
  it("marks an existing on-chain resource registered", async () => {
    batch([resource]);
    m.exists.mockResolvedValue(true);
    await start();
    expect(m.exists).toHaveBeenCalledWith(resource.id);
    expect(m.set).toHaveBeenCalledWith({ onchainStatus: "registered" });
    expect(m.register).not.toHaveBeenCalled();
  });
  it("registers for the server wallet and saves the transaction hash", async () => {
    batch([resource]);
    await start();
    expect(m.register).toHaveBeenCalledWith(expect.objectContaining({ id: resource.id, creator: "GREGISTRY", price: 10000000n }));
    expect(m.set).toHaveBeenCalledWith({ onchainStatus: "registered", onchainTxHash: "tx-hash" });
  });
  it("requires a client signature for another wallet", async () => {
    batch([{ ...resource, walletAddress: "GOTHER" }]);
    await start();
    expect(m.register).not.toHaveBeenCalled();
    expect(m.set).toHaveBeenCalledWith({ onchainStatus: "failed" });
  });
  it("leaves failed registration attempts retryable within the limit", async () => {
    batch([resource]);
    m.register.mockRejectedValue(new Error("RPC down"));
    await start();
    expect(m.set).not.toHaveBeenCalledWith({ onchainStatus: "failed" });
    expect(m.select).toHaveBeenCalledTimes(3);
  });
  it("stops registration after persisted attempts exceed the limit", async () => {
    batch([resource]);
    m.returning.mockResolvedValue([{ onchainAttempts: 4 }]);
    await start();
    expect(m.exists).not.toHaveBeenCalled();
    expect(m.set).toHaveBeenCalledWith({ onchainStatus: "failed" });
  });
  it.each(["SUCCESS", "FAILED", "PENDING"])("polls a stored transaction in state %s without resubmitting", async (status) => {
    batch([{ ...resource, onchainTxHash: "stored-hash" }]);
    m.poll.mockResolvedValue({ status });
    await start();
    expect(m.poll).toHaveBeenCalledWith("stored-hash", { maxAttempts: 1, intervalMs: 0 });
    expect(m.register).not.toHaveBeenCalled();
    if (status === "PENDING") expect(m.set).toHaveBeenCalledTimes(1);
    else expect(m.set).toHaveBeenCalledWith({ onchainStatus: status === "SUCCESS" ? "registered" : "failed" });
  });
  it("continues cleanup after the registration query fails", async () => {
    batch([], [{ id: "job", storagePath: "object", attempts: 0 }]);
    m.select.mockImplementationOnce(() => { throw new Error("DB down"); });
    await start();
    expect(m.deleteFile).toHaveBeenCalledWith("object");
    expect(m.remove).toHaveBeenCalled();
  });
  it("persists cleanup retry attempts", async () => {
    batch([], [{ id: "job", storagePath: "object", attempts: 1 }]);
    m.deleteFile.mockRejectedValue(new Error("storage down"));
    await start();
    expect(m.set).toHaveBeenCalledWith(
      expect.objectContaining({ attempts: 2, nextAttemptAt: expect.any(Date) }),
    );
    expect(m.remove).not.toHaveBeenCalled();
  });
  it("retains a failed cleanup job after the normal retry budget", async () => {
    batch([], [{ id: "job", storagePath: "thumbnail", attempts: 4 }]);
    m.deleteFile.mockRejectedValue(new Error("storage down"));
    await start();
    expect(m.set).toHaveBeenCalledWith(
      expect.objectContaining({ attempts: 5, nextAttemptAt: expect.any(Date) }),
    );
    expect(m.remove).not.toHaveBeenCalled();
  });
  it("uploads thumbnails with upsert so a retry after a mid-flight crash recovers", async () => {
    batch([], [], [{ id: "res-1", storagePath: "res-1/file.png", mimeType: "image/png", thumbnailStatus: "pending" }]);
    m.downloadFile.mockResolvedValue({ buffer: Buffer.from("img"), mimeType: "image/png" });
    m.uploadFile.mockResolvedValue("res-1/thumb_file.png");
    await start();
    expect(m.uploadFile).toHaveBeenCalledWith(
      "res-1",
      expect.any(Buffer),
      "thumb_file.png",
      "image/jpeg",
      { upsert: true },
    );
    expect(m.set).toHaveBeenCalledWith({ thumbnailPath: "res-1/thumb_file.png", thumbnailStatus: "ready" });
  });
  it("retries a transient storage fault instead of terminally failing the thumbnail (#167)", async () => {
    batch([], [], [{ id: "res-1", storagePath: "res-1/file.png", mimeType: "image/png", thumbnailStatus: "pending", thumbnailAttempts: 0 }]);
    m.downloadFile.mockRejectedValue(new Error("storage 503"));
    await start();
    expect(m.set).toHaveBeenCalledWith({ thumbnailAttempts: 1 });
    expect(m.set).not.toHaveBeenCalledWith(expect.objectContaining({ thumbnailStatus: "failed" }));
  });
  it("fails the thumbnail once transient retries are exhausted", async () => {
    batch([], [], [{ id: "res-1", storagePath: "res-1/file.png", mimeType: "image/png", thumbnailStatus: "pending", thumbnailAttempts: 4 }]);
    m.downloadFile.mockRejectedValue(new Error("storage 503"));
    await start();
    expect(m.set).toHaveBeenCalledWith({ thumbnailStatus: "failed", thumbnailAttempts: 5 });
  });
  it("terminally fails a corrupt image without counting it as a transient attempt", async () => {
    batch([], [], [{ id: "res-1", storagePath: "res-1/file.png", mimeType: "image/png", thumbnailStatus: "pending", thumbnailAttempts: 0 }]);
    m.downloadFile.mockResolvedValue({ buffer: Buffer.from("not-an-image"), mimeType: "image/png" });
    m.sharpToBuffer.mockRejectedValue(new Error("unsupported image format"));
    await start();
    expect(m.set).toHaveBeenCalledWith({ thumbnailStatus: "failed" });
    expect(m.uploadFile).not.toHaveBeenCalled();
  });
  it("stops scheduling work after stop", async () => {
    batch();
    await start();
    stopRetryPendingWorker();
    await vi.advanceTimersByTimeAsync(180000);
    expect(m.select).toHaveBeenCalledTimes(3);
  });
});
