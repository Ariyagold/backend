import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";

function mockDeps(redisUrl: string) {
  vi.doMock("../config.js", () => ({
    config: { REQUIRE_REQUEST_SIGNATURE: true, SIGNATURE_MAX_SKEW_MS: 300_000, REDIS_URL: redisUrl },
  }));
  vi.doMock("../db/client.js", () => ({ db: {} }));
  vi.doMock("../db/schema.js", () => ({ publishers: {} }));
}

class FakeRedisClient extends EventEmitter {
  isOpen = false;
  isReady = false;
  quit = vi.fn(async () => {
    this.isOpen = false;
    this.isReady = false;
    this.emit("end");
  });
  disconnect = vi.fn(async () => {
    this.isOpen = false;
    this.isReady = false;
    this.emit("end");
  });
  constructor(public options: { socket: { reconnectStrategy: (n: number) => number | Error } }) {
    super();
  }
  async connect() {
    this.isOpen = true;
    this.isReady = true;
  }
}

afterEach(() => {
  vi.resetModules();
  vi.doUnmock("redis");
  vi.doUnmock("../config.js");
  vi.doUnmock("../db/client.js");
  vi.doUnmock("../db/schema.js");
});

describe("closeSignatureReplayStore", () => {
  it("quits the replay Redis client, stops the prune timer and cancels reconnects", async () => {
    mockDeps("redis://fake:6379");
    const created: FakeRedisClient[] = [];
    vi.doMock("redis", () => ({
      createClient: (opts: FakeRedisClient["options"]) => {
        const c = new FakeRedisClient(opts);
        created.push(c);
        return c;
      },
    }));

    const mod = await import("./requestSignatureAuth.js");
    const before = await mod.__replayStoreStateForTests();
    expect(before.client).toBe(created[0]);
    expect(before.pruneTimerActive).toBe(true);
    // node-redis' own (uncancellable) reconnect loop is disabled.
    expect(created[0].options.socket.reconnectStrategy(0)).toBeInstanceOf(Error);

    await mod.closeSignatureReplayStore();

    expect(created[0].quit).toHaveBeenCalledOnce();
    const after = await mod.__replayStoreStateForTests();
    expect(after).toMatchObject({ closed: true, pruneTimerActive: false, client: null });
    // No new client is created after close.
    expect(created).toHaveLength(1);

    // Idempotent.
    await expect(mod.closeSignatureReplayStore()).resolves.toBeUndefined();
  });

  it("waits for an in-flight connect and then closes that client", async () => {
    mockDeps("redis://fake:6379");
    let finishConnect!: () => void;
    let client!: FakeRedisClient;
    vi.doMock("redis", () => ({
      createClient: (opts: FakeRedisClient["options"]) => {
        client = new FakeRedisClient(opts);
        client.connect = () =>
          new Promise<void>((resolve) => {
            finishConnect = () => {
              client.isOpen = true;
              client.isReady = true;
              resolve();
            };
          });
        return client;
      },
    }));

    const mod = await import("./requestSignatureAuth.js");
    const pending = mod.__replayStoreStateForTests();
    await vi.waitFor(() => expect(finishConnect).toBeDefined());

    const closing = mod.closeSignatureReplayStore();
    finishConnect();
    await closing;

    expect(client.quit).toHaveBeenCalledOnce();
    expect(client.isOpen).toBe(false);
    await expect(pending).resolves.toMatchObject({ closed: true, client: null });
  });

  it("leaves no sockets or timers behind against a real unreachable Redis", async () => {
    mockDeps("redis://127.0.0.1:1");
    const count = (type: string) => process.getActiveResourcesInfo().filter((r) => r === type).length;
    const baseSockets = count("TCPSocketWrap");

    const mod = await import("./requestSignatureAuth.js");
    const baseTimers = count("Timeout");
    const pending = mod.__replayStoreStateForTests();
    // Give the client a moment to open its socket / schedule a reconnect.
    await new Promise((r) => setTimeout(r, 50));

    await mod.closeSignatureReplayStore();
    await pending;
    // Destroyed sockets release their libuv handle asynchronously.
    await vi.waitFor(() => expect(count("TCPSocketWrap")).toBe(baseSockets), { timeout: 1_000 });
    // The prune interval was cleared, so there is one fewer timer than at import.
    expect(count("Timeout")).toBeLessThan(baseTimers);
  });
});
