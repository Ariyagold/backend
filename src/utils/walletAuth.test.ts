import { describe, expect, it } from "vitest";
import {
  buildWalletAuthMessageV1,
  buildWalletAuthMessageV2,
  canonicalizeQuery,
  rawQueryFromUrl,
} from "./walletAuth.js";

describe("canonicalizeQuery", () => {
  it("returns an empty string for an empty query", () => {
    expect(canonicalizeQuery("")).toBe("");
  });

  it("sorts by key then value and keeps duplicates", () => {
    expect(canonicalizeQuery("b=2&a=2&a=1")).toBe("a=1&a=2&b=2");
  });

  it("normalises equivalent encodings", () => {
    expect(canonicalizeQuery("q=a+b")).toBe(canonicalizeQuery("q=a%20b"));
    expect(canonicalizeQuery("q=%c3%a9")).toBe(canonicalizeQuery("q=%C3%A9"));
    expect(canonicalizeQuery("q=it's(*)!")).toBe("q=it%27s%28%2A%29%21");
  });

  it("distinguishes different values", () => {
    expect(canonicalizeQuery("limit=10")).not.toBe(canonicalizeQuery("limit=100"));
    expect(canonicalizeQuery("a=1")).not.toBe(canonicalizeQuery("a=1&a=1"));
  });
});

describe("rawQueryFromUrl", () => {
  it("extracts the query without fragment", () => {
    expect(rawQueryFromUrl("/x?a=1&b=2#frag")).toBe("a=1&b=2");
    expect(rawQueryFromUrl("/x")).toBe("");
  });
});

describe("wallet auth messages", () => {
  it("builds versioned messages", () => {
    expect(buildWalletAuthMessageV1({ method: "get", path: "/p", timestamp: "1" })).toBe(
      "synapsvault-wallet-auth-v1\nGET\n/p\n1",
    );
    expect(buildWalletAuthMessageV2({ method: "get", path: "/p", rawQuery: "b=2&a=1", timestamp: "1" })).toBe(
      "synapsvault-wallet-auth-v2\nGET\n/p\na=1&b=2\n1",
    );
  });
});
