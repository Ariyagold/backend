import { createClient } from "@supabase/supabase-js";
import { Readable } from "node:stream";
import { config } from "../config.js";

// Create client with realtime disabled — avoids WebSocket requirement on Node 20
// Storage operations (upload/download/delete) do not need realtime subscriptions
const supabase = createClient(config.SUPABASE_URL, config.SUPABASE_SERVICE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
  realtime: {
    params: { eventsPerSecond: -1 },
  },
});

const bucket = config.SUPABASE_STORAGE_BUCKET;

export class StorageNotFoundError extends Error {
  readonly statusCode = 404;
  readonly code = "STORAGE_NOT_FOUND";

  constructor(storagePath: string) {
    super(`Object not found in storage: ${storagePath}`);
    this.name = "StorageNotFoundError";
  }
}

export class StorageRangeNotSatisfiableError extends Error {
  readonly statusCode = 416;
  readonly code = "STORAGE_RANGE_NOT_SATISFIABLE";
  readonly totalSize: number;

  constructor(storagePath: string, totalSize: number) {
    super(`Requested range not satisfiable for storage object: ${storagePath}`);
    this.name = "StorageRangeNotSatisfiableError";
    this.totalSize = totalSize;
  }
}

export async function uploadFile(
  resourceId: string,
  fileBuffer: Buffer,
  filename: string,
  mimeType: string,
  options?: { upsert?: boolean },
): Promise<string> {
  const storagePath = `${resourceId}/${filename}`;
  const { error } = await supabase.storage.from(bucket).upload(storagePath, fileBuffer, {
    contentType: mimeType,
    upsert: options?.upsert ?? false,
  });
  if (error) throw new Error(`Upload failed: ${error.message}`);
  return storagePath;
}

/**
 * Stream a file to Supabase storage without buffering it fully in memory.
 * Accepts any Node readable stream (e.g. a disk read stream from multer's
 * diskStorage) and pipes it directly into the storage upload.
 */
export async function uploadFileStream(
  resourceId: string,
  stream: Readable,
  filename: string,
  mimeType: string,
): Promise<string> {
  const storagePath = `${resourceId}/${filename}`;
  const { error } = await supabase.storage.from(bucket).upload(storagePath, stream, {
    contentType: mimeType,
    upsert: false,
    duplex: "half",
  } as Parameters<ReturnType<typeof supabase.storage.from>["upload"]>[2]);
  if (error) throw new Error(`Upload failed: ${error.message}`);
  return storagePath;
}

export async function downloadFile(
  storagePath: string,
): Promise<{ buffer: Buffer; mimeType: string }> {
  const { data, error } = await supabase.storage.from(bucket).download(storagePath);
  if (error) {
    const statusCode = (error as { statusCode?: number | string }).statusCode;
    const isNotFound =
      String(statusCode) === "404" ||
      /not\s*found/i.test(error.message ?? "");
    if (isNotFound) throw new StorageNotFoundError(storagePath);
    throw new Error(`Download failed: ${error.message}`);
  }
  const buffer = Buffer.from(await data.arrayBuffer());
  const mimeType = data.type || "application/octet-stream";
  return { buffer, mimeType };
}

/**
 * Download a single byte range of a stored object.
 *
 * `start` and `end` are inclusive byte offsets. The returned buffer contains
 * exactly the requested bytes (or fewer if `end` exceeds the object size, per
 * RFC 7233), along with the total object size and mime type.
 *
 * Throws `StorageRangeNotSatisfiableError` when `start` is beyond the object
 * size or the range is otherwise invalid.
 */
export async function downloadFileRange(
  storagePath: string,
  start: number,
  end: number,
): Promise<{ buffer: Buffer; mimeType: string; totalSize: number; start: number; end: number }> {
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end < start) {
    throw new StorageRangeNotSatisfiableError(storagePath, 0);
  }

  const { data, error } = await supabase.storage
    .from(bucket)
    .download(storagePath, {}, { headers: { Range: `bytes=${start}-${end}` } });
  if (error) {
    const statusCode = (error as { statusCode?: number | string }).statusCode;
    const isNotFound =
      String(statusCode) === "404" ||
      /not\s*found/i.test(error.message ?? "");
    if (isNotFound) throw new StorageNotFoundError(storagePath);
    if (String(statusCode) === "416") {
      throw new StorageRangeNotSatisfiableError(storagePath, 0);
    }
    throw new Error(`Download failed: ${error.message}`);
  }

  const mimeType = data.type || "application/octet-stream";
  const fullBuffer = Buffer.from(await data.arrayBuffer());

  // Determine whether the backend honored the Range header. If it returned a
  // partial response, the buffer already holds only the requested bytes.
  const contentRange = data.headers?.get?.("content-range") ?? null;
  const status = data.headers?.get?.("content-range") ? 206 : data.status;

  if (status === 206 && contentRange) {
    const match = /bytes\s+(\d+)-(\d+)\/(\d+|\*)/i.exec(contentRange);
    if (match) {
      const totalSize = match[3] === "*" ? fullBuffer.length : Number(match[3]);
      const actualStart = Number(match[1]);
      const actualEnd = Number(match[2]);
      return {
        buffer: fullBuffer,
        mimeType,
        totalSize,
        start: actualStart,
        end: actualEnd,
      };
    }
  }

  // Backend ignored the Range header and returned the full object; slice it.
  const totalSize = fullBuffer.length;
  if (start >= totalSize) {
    throw new StorageRangeNotSatisfiableError(storagePath, totalSize);
  }
  const clampedEnd = Math.min(end, totalSize - 1);
  return {
    buffer: fullBuffer.subarray(start, clampedEnd + 1),
    mimeType,
    totalSize,
    start,
    end: clampedEnd,
  };
}

export async function deleteFile(storagePath: string): Promise<void> {
  const { error } = await supabase.storage.from(bucket).remove([storagePath]);
  if (!error) return;

  const statusCode = (error as { statusCode?: number | string }).statusCode;
  if (String(statusCode) === "404" || /not\s*found/i.test(error.message ?? "")) return;
  throw new Error(`Delete failed: ${error.message}`);
}
