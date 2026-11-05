import { randomBytes } from "node:crypto";
import { constants as fsConstants, promises as fs } from "node:fs";
import path from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream as WebReadableStream } from "node:stream/web";
import { BudgetExhausted, Deadline } from "./client.js";
import {
  ESSENTIAL_RESPONSE_FIELDS,
  SPILL_WRITE_TIMEOUT_MS,
  INLINE_RESULT_MAX_CHARS,
  MAX_DOWNLOAD_MB,
  MAX_INLINE_FILE_MB,
  MIN_DOWNLOAD_MS,
  PREVIEW_CHARS,
  RESULTS_DIR,
} from "./constants.js";

export interface LocalFile {
  contents: string;
  filename: string;
}

export class LocalFileTimeout extends Error {}

export function resolvePath(filePath: string): string {
  return path.resolve(process.cwd(), filePath);
}

// local disk work can stall (network or cloud-synced folders); the tool answers on time even if the operation lingers
export async function withinDeadline<T>(operation: Promise<T>, deadline: Deadline, onTimeout: () => Error): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(onTimeout()), deadline.remainingMs());
  });
  try {
    return await Promise.race([operation, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

async function readLocalFileUnbounded(fullPath: string): Promise<LocalFile> {
  const maxBytes = MAX_INLINE_FILE_MB * 1024 * 1024;
  let handle;
  try {
    // non-blocking open so a fifo or device can't hang the call; checks run on the opened descriptor, not the path
    handle = await fs.open(fullPath, fsConstants.O_RDONLY | fsConstants.O_NONBLOCK);
  } catch {
    throw new Error(`File not found or not readable: ${fullPath}`);
  }
  try {
    const stats = await handle.stat();
    if (!stats.isFile()) throw new Error(`Not a regular file: ${fullPath}`);
    if (stats.size > maxBytes) {
      throw new Error(`File is ${(stats.size / 1024 / 1024).toFixed(1)} MB; the limit for local files is ${MAX_INLINE_FILE_MB} MB. Host it somewhere reachable and pass its URL instead.`);
    }
    const buffer = Buffer.alloc(stats.size);
    let offset = 0;
    while (offset < stats.size) {
      const { bytesRead } = await handle.read(buffer, offset, stats.size - offset, offset);
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    return { contents: buffer.subarray(0, offset).toString("base64"), filename: path.basename(fullPath) };
  } finally {
    await handle.close();
  }
}

export async function readLocalFile(filePath: string, deadline: Deadline): Promise<LocalFile> {
  const fullPath = resolvePath(filePath);
  return withinDeadline(readLocalFileUnbounded(fullPath), deadline,
    () => new LocalFileTimeout(`Reading ${fullPath} took too long, so nothing was uploaded. Try again, or pass a URL instead.`));
}

export function documentSource(filePath?: string, url?: string): "file" | "url" {
  if (filePath && url) throw new Error("Pass either file_path or url, not both.");
  if (!filePath && !url) throw new Error("Pass file_path (a local file) or url.");
  return filePath ? "file" : "url";
}

export async function buildInputDocument(filePath: string | undefined, url: string | undefined, deadline: Deadline): Promise<Record<string, unknown>> {
  if (documentSource(filePath, url) === "url") return { url };
  const file = await readLocalFile(filePath as string, deadline);
  return { file: { contents: file.contents, filename: file.filename } };
}

export async function writeJson(target: string, value: unknown, deadline?: Deadline): Promise<{ path: string; bytes: number }> {
  const fullPath = resolvePath(target);
  const text = JSON.stringify(value, null, 2);
  const write = (async () => {
    await fs.mkdir(path.dirname(fullPath), { recursive: true });
    await fs.writeFile(fullPath, text, "utf8");
  })();
  if (deadline) await withinDeadline(write, deadline, () => new BudgetExhausted());
  else await write;
  return { path: fullPath, bytes: Buffer.byteLength(text) };
}

export async function downloadTo(url: string, target: string, deadline: Deadline): Promise<{ path: string; bytes: number }> {
  if (!deadline.hasTimeFor(MIN_DOWNLOAD_MS)) throw new BudgetExhausted();
  return withinDeadline(downloadUnbounded(url, target, deadline), deadline, () => new BudgetExhausted());
}

async function downloadUnbounded(url: string, target: string, deadline: Deadline): Promise<{ path: string; bytes: number }> {
  const maxBytes = MAX_DOWNLOAD_MB * 1024 * 1024;
  const fullPath = resolvePath(target);
  await fs.mkdir(path.dirname(fullPath), { recursive: true });

  // a uniquely named temp file created exclusively, so only a file this call made is ever written or removed
  const tempPath = path.join(path.dirname(fullPath), `.${path.basename(fullPath)}.${randomBytes(6).toString("hex")}.part`);
  const handle = await fs.open(tempPath, "wx");
  let bytes = 0;
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(deadline.remainingMs()) });
    if (!response.ok || !response.body) throw new Error(`Download failed with HTTP ${response.status}`);
    const limit = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        bytes += chunk.length;
        callback(bytes > maxBytes ? new Error(`Download is larger than ${MAX_DOWNLOAD_MB} MB`) : null, chunk);
      },
    });
    await pipeline(Readable.fromWeb(response.body as WebReadableStream), limit, handle.createWriteStream());
    await fs.rename(tempPath, fullPath);
  } catch (error) {
    await handle.close().catch(() => undefined);
    await fs.rm(tempPath, { force: true });
    if (error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError")) throw new BudgetExhausted();
    throw error;
  }
  return { path: fullPath, bytes };
}

// spills go to fresh, exclusively created files in a real (not symlinked) results folder, with their own short time limit
async function writeSpill(fileStem: string, value: unknown): Promise<{ path: string; bytes: number } | undefined> {
  const text = JSON.stringify(value, null, 2);
  const dir = resolvePath(RESULTS_DIR);
  const write = (async () => {
    await fs.mkdir(dir, { recursive: true });
    const stats = await fs.lstat(dir);
    if (!stats.isDirectory() || stats.isSymbolicLink()) throw new Error(`${dir} is not a plain folder`);
    const fullPath = path.join(dir, `${fileStem}-${randomBytes(4).toString("hex")}.json`);
    const handle = await fs.open(fullPath, "wx");
    try {
      await handle.writeFile(text, "utf8");
    } finally {
      await handle.close();
    }
    return { path: fullPath, bytes: Buffer.byteLength(text) };
  })();
  try {
    return await withinDeadline(write, new Deadline(SPILL_WRITE_TIMEOUT_MS), () => new Error("saving the result file took too long"));
  } catch {
    return undefined;
  }
}

// a large field moves to its own file; spilledFiles keeps one pointer per field so none overwrites another
export async function fitInline(payload: Record<string, unknown>, largeField: string, fileStem: string): Promise<Record<string, unknown>> {
  const value = payload[largeField];
  const text = JSON.stringify(value);
  if (text === undefined || text.length <= INLINE_RESULT_MAX_CHARS) return payload;
  const saved = await writeSpill(fileStem, value);
  const spilledFiles = { ...((payload.spilledFiles as Record<string, unknown> | undefined) ?? {}) };
  spilledFiles[largeField] = saved
    ? { path: saved.path, bytes: saved.bytes, preview: text.slice(0, PREVIEW_CHARS) }
    : { error: "too large to return and could not be saved to a file", preview: text.slice(0, PREVIEW_CHARS) };
  return { ...payload, [largeField]: undefined, truncated: true, spilledFiles };
}

// last guard on the whole response: the full payload goes to a file and only essential fields stay, under one budget
export async function capResponse(payload: Record<string, unknown>, fileStem: string): Promise<Record<string, unknown>> {
  const text = JSON.stringify(payload);
  if (text.length <= INLINE_RESULT_MAX_CHARS) return payload;
  const saved = await writeSpill(fileStem, payload);
  const capped: Record<string, unknown> = saved
    ? { truncated: true, fullResponseSavedTo: saved.path, fullResponseBytes: saved.bytes }
    : { truncated: true, fullResponseError: "too large to return and could not be saved to a file" };
  for (const field of ESSENTIAL_RESPONSE_FIELDS) {
    if (payload[field] === undefined) continue;
    const candidate = { ...capped, [field]: payload[field] };
    if (JSON.stringify(candidate).length <= INLINE_RESULT_MAX_CHARS - PREVIEW_CHARS) Object.assign(capped, { [field]: payload[field] });
  }
  let previewLength = PREVIEW_CHARS;
  while (previewLength > 0 && JSON.stringify({ ...capped, preview: text.slice(0, previewLength) }).length > INLINE_RESULT_MAX_CHARS) {
    previewLength = Math.floor(previewLength / 2);
  }
  if (previewLength > 0) capped.preview = text.slice(0, previewLength);
  return capped;
}
