import { beforeEach, describe, expect, it, vi } from "vitest";

const mock = vi.hoisted(() => ({ remove: vi.fn() }));
vi.mock("@supabase/supabase-js", () => ({
  createClient: () => ({ storage: { from: () => ({ remove: mock.remove }) } }),
}));
vi.mock("../config.js", () => ({
  config: {
    SUPABASE_URL: "https://placeholder.supabase.co",
    SUPABASE_SERVICE_KEY: "test-key",
    SUPABASE_STORAGE_BUCKET: "resources",
  },
}));

import { deleteFile } from "./supabaseStorage.js";

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
