import { beforeEach, describe, expect, it, vi } from "vitest";

const mock = vi.hoisted(() => ({
  remove: vi.fn(),
  download: vi.fn(),
  createSignedUrl: vi.fn(),
}));
vi.mock("@supabase/supabase-js", () => ({
  createClient: () => ({
    storage: {
      from: () => ({
        remove: mock.remove,
        download: mock.download,
        createSignedUrl: mock.createSignedUrl,
      }),
    },
  }),
}));
vi.mock("../config.js", () => ({
  config: {
    SUPABASE_URL: "https://placeholder.supabase.co",
    SUPABASE_SERVICE_KEY: "test-key",
    SUPABASE_STORAGE_BUCKET: "resources",
  },
}));

import { deleteFile, downloadFileRange } from "./supabaseStorage.js";

describe("deleteFile", () => {
  beforeEach(() => {
    mock.remove.mockReset();
    mock.remove.mockResolvedValue({ error: null });
  });

  it("treats an already missing object as successfully deleted", async () => {
    mock.remove.mockResolvedValue({
      error: Object.assign(new Error("Object not found"), { statusCode: 404 }),
    });

    await expect(deleteFile("resource/thumb.jpg")).resolves.toBeUndefined();
  });

  it("surfaces non-not-found storage failures", async () => {
    mock.remove.mockResolvedValue({ error: new Error("storage unavailable") });

    await expect(deleteFile("resource/thumb.jpg")).rejects.toThrow(
      "Delete failed: storage unavailable",
    );
  });
});

function makeBlob(bytes: Uint8Array): Blob {
  return new Blob([bytes]);
}

describe("downloadFileRange", () => {
  beforeEach(() => {
    mock.download.mockReset();
    mock.createSignedUrl.mockReset();
  });

  it("returns a valid single range with correct 206 metadata", async () => {
    const content = new Uint8Array([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
    mock.download.mockResolvedValue({
      data: makeBlob(content),
      error: null,
    });

    const result = await downloadFileRange("resource/audio.mp3", {
      start: 2,
      end: 5,
    });

    expect(result.status).toBe(206);
    expect(result.contentRange).toBe("bytes 2-5/10");
    expect(result.totalSize).toBe(10);
    expect(Array.from(result.body)).toEqual([2, 3, 4, 5]);
  });

  it("returns 416 with Content-Range for an unsatisfiable range", async () => {
    const content = new Uint8Array([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
    mock.download.mockResolvedValue({
      data: makeBlob(content),
      error: null,
    });

    const result = await downloadFileRange("resource/audio.mp3", {
      start: 20,
      end: 30,
    });

    expect(result.status).toBe(416);
    expect(result.contentRange).toBe("bytes */10");
    expect(result.totalSize).toBe(10);
    expect(result.body.length).toBe(0);
  });

  it("falls back to slicing when the storage layer ignores the range", async () => {
    const content = new Uint8Array([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
    // Simulate a storage backend that returns the full object regardless of
    // the requested range (no native range support).
    mock.download.mockResolvedValue({
      data: makeBlob(content),
      error: null,
    });

    const result = await downloadFileRange(
      "resource/video.mp4",
      { start: 3, end: 6 },
      { nativeRange: false },
    );

    expect(result.status).toBe(206);
    expect(result.contentRange).toBe("bytes 3-6/10");
    expect(result.totalSize).toBe(10);
    expect(Array.from(result.body)).toEqual([3, 4, 5, 6]);
  });
});