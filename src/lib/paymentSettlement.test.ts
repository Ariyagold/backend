import { describe, it, expect, vi, beforeEach } from "vitest";
import { EventEmitter } from "node:events";

const returning = vi.fn();
vi.mock("../db/client.js", () => ({
  db: { update: () => ({ set: () => ({ where: () => ({ returning }) }) }) },
}));

import { recordSettlementOnFinish, settlementKeyFromHeader } from "./paymentSettlement.js";

function fakeRes(statusCode: number, headers: Record<string, string> = {}) {
  const res: any = new EventEmitter();
  res.statusCode = statusCode;
  res.getHeader = (k: string) => headers[k.toLowerCase()];
  return res;
}
const flush = () => new Promise((r) => setTimeout(r, 10));

describe("recordSettlementOnFinish", () => {
  beforeEach(() => returning.mockReset());

  it("emits success callback only after confirmed settlement", async () => {
    returning.mockResolvedValue([{ id: "p1" }]);
    const onSettled = vi.fn();
    const hdr = Buffer.from(JSON.stringify({ success: true, transaction: "0xabc" })).toString("base64");
    const res = fakeRes(200, { "x-payment-response": hdr });
    recordSettlementOnFinish(res, "p1", onSettled);
    res.emit("finish");
    await flush();
    expect(onSettled).toHaveBeenCalledTimes(1);
  });

  it("does not emit for a failed settlement", async () => {
    returning.mockResolvedValue([{ id: "p1" }]);
    const onSettled = vi.fn();
    const res = fakeRes(402);
    recordSettlementOnFinish(res, "p1", onSettled);
    res.emit("finish");
    await flush();
    expect(onSettled).not.toHaveBeenCalled();
  });

  it("does not emit when settlement is reported unsuccessful despite 200", async () => {
    returning.mockResolvedValue([{ id: "p1" }]);
    const onSettled = vi.fn();
    const hdr = Buffer.from(JSON.stringify({ success: false, errorReason: "insufficient_funds" })).toString("base64");
    const res = fakeRes(200, { "x-payment-response": hdr });
    recordSettlementOnFinish(res, "p1", onSettled);
    res.emit("finish");
    await flush();
    expect(onSettled).not.toHaveBeenCalled();
  });

  it("does not emit on duplicate callback (no pending row transitioned)", async () => {
    returning.mockResolvedValue([]);
    const onSettled = vi.fn();
    const res = fakeRes(200);
    recordSettlementOnFinish(res, "p1", onSettled);
    res.emit("finish");
    await flush();
    expect(onSettled).not.toHaveBeenCalled();
  });

  it("derives a stable key", () => {
    expect(settlementKeyFromHeader("a")).toBe(settlementKeyFromHeader("a"));
    expect(settlementKeyFromHeader(undefined)).toBeNull();
  });
});
