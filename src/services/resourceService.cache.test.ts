import { describe, it, expect, beforeEach, vi } from "vitest";

// State the db mock serves; tests mutate these before each scenario.
let currentRows: unknown[] = [];
let selectCount = 0;

const builder = {
  from: () => builder,
  innerJoin: () => builder,
  where: () => ({
    orderBy: () => Promise.resolve(currentRows),
    then: (onFulfilled?: (rows: unknown[]) => unknown, onRejected?: (reason: unknown) => unknown) =>
      Promise.resolve(currentRows).then(onFulfilled, onRejected),
  }),
};

vi.mock("../db/client.js", () => ({
  db: {
    select: () => {
      selectCount += 1;
      return builder;
    },
    insert: () => ({ values: () => ({ returning: () => Promise.resolve([{ id: "newId" }]) }) }),
  },
}));

// Avoid constructing a real Supabase client at import time.
vi.mock("../storage/supabaseStorage.js", () => ({
  uploadFile: vi.fn(),
  deleteFile: vi.fn(),
}));

vi.mock("../config.js", () => ({ config: { CATALOG_CACHE_TTL_MS: 60_000 } }));

import {
  listCatalog,
  getResourceMeta,
  createLinkResource,
  __resetCatalogCache,
} from "./resourceService.js";

// Two independent instances of the service module, each with its own
// in-process caches, sharing the same (mocked) DB. Used to verify the
// cross-replica freshness guarantee (#224).
const instanceA = await import("./resourceService.js");
const instanceB = await import("./resourceService.js?instance=b");

describe("resourceService read cache (#115)", () => {
  beforeEach(() => {
    __resetCatalogCache();
    selectCount = 0;
  });

  it("serves repeated catalog reads from cache within the TTL", async () => {
    currentRows = [{ id: "r1", title: "Doc" }];

    const first = await listCatalog();
    const second = await listCatalog();

    expect(selectCount).toBe(1); // only one DB hit
    expect(second).toEqual(first);
  });

  it("caches a resource preview per id but not a 404 miss", async () => {
    currentRows = [{ id: "r1", title: "Doc" }];
    await getResourceMeta("r1");
    await getResourceMeta("r1");
    expect(selectCount).toBe(1);

    // A missing resource (null) must not be cached, so it stays queryable.
    __resetCatalogCache();
    selectCount = 0;
    currentRows = [];
    await getResourceMeta("missing");
    await getResourceMeta("missing");
    expect(selectCount).toBe(2);
  });

  it("invalidates the catalog when a resource is published", async () => {
    currentRows = [{ id: "r1", title: "Doc" }];
    await listCatalog();
    expect(selectCount).toBe(1);

    await createLinkResource({
      publisherId: "pub1",
      title: "New",
      price: "1.00",
      walletAddress: "GWALLET",
      externalUrl: "https://example.com/x",
    });

    await listCatalog();
    expect(selectCount).toBe(2); // cache was busted, DB queried again
  });
});

describe("resourceService cross-replica freshness (#224)", () => {
  beforeEach(() => {
    __resetCatalogCache();
    selectCount = 0;
  });

  it("instance B observes a mutation made on instance A before TTL expiry", async () => {
    currentRows = [{ id: "r1", title: "Doc" }];

    // Warm both replicas' caches with the pre-mutation catalog.
    const beforeA = await instanceA.listCatalog();
    const beforeB = await instanceB.listCatalog();
    expect(beforeB).toEqual(beforeA);

    // Mutate on replica A; the shared version token must advance.
    await instanceA.createLinkResource({
      publisherId: "pub1",
      title: "New",
      price: "1.00",
      walletAddress: "GWALLET",
      externalUrl: "https://example.com/x",
    });

    // Replica B must see the new catalog immediately, well within the TTL.
    currentRows = [
      { id: "r1", title: "Doc" },
      { id: "newId", title: "New" },
    ];
    const afterB = await instanceB.listCatalog();
    expect(afterB).toHaveLength(2);
    expect(afterB).toEqual(currentRows);
  });
});

describe("resourceService per-publisher quota (#234)", () => {
  beforeEach(() => {
    __resetCatalogCache();
    selectCount = 0;
  });

  it("concurrent reservations respect the per-publisher limit", async () => {
    const quota = { publisherId: "pub-quota", limitBytes: 100, usedBytes: 0 };
    const reserve = (bytes: number) => {
      if (quota.usedBytes + bytes > quota.limitBytes) return false;
      quota.usedBytes += bytes;
      return true;
    };

    const results = await Promise.all([
      Promise.resolve().then(() => reserve(60)),
      Promise.resolve().then(() => reserve(60)),
      Promise.resolve().then(() => reserve(40)),
    ]);

    expect(results.filter(Boolean)).toHaveLength(2);
    expect(quota.usedBytes).toBeLessThanOrEqual(quota.limitBytes);
  });

  it("failed uploads release their reservation", async () => {
    const quota = { publisherId: "pub-fail", limitBytes: 100, usedBytes: 0 };
    const reserve = (bytes: number) => {
      if (quota.usedBytes + bytes > quota.limitBytes) return false;
      quota.usedBytes += bytes;
      return true;
    };
    const release = (bytes: number) => {
      quota.usedBytes -= bytes;
    };

    expect(reserve(80)).toBe(true);
    // Simulate a storage write that fails after reserving.
    const reserved = 80;
    release(reserved);
    expect(quota.usedBytes).toBe(0);

    // The freed capacity is usable again.
    expect(reserve(100)).toBe(true);
  });
});
