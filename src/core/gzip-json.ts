import { createReadStream, createWriteStream } from "node:fs";
import { createHash } from "node:crypto";
import { mkdir, rename, rm } from "node:fs/promises";
import { Readable } from "node:stream";
import { Transform } from "node:stream";
import { Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createGzip, createGunzip } from "node:zlib";
import path from "node:path";
import { deserialize, serialize } from "node:v8";
import { parser } from "stream-json";
import { streamValues, type StreamValuesItem } from "stream-json/streamers/stream-values.js";
import { fileExists } from "./files.js";

export async function writeGzipJson(filePath: string, value: unknown): Promise<void> {
  await writeGzipStream(filePath, jsonTextStream(value));
}

export async function writeGzipSerialized(filePath: string, value: unknown): Promise<void> {
  await writeGzipStream(filePath, Readable.from([serialize(value)]));
}

export async function readGzipSerialized<T>(filePath: string): Promise<T> {
  const chunks: Buffer[] = [];
  await pipeline(
    createReadStream(filePath),
    createGunzip(),
    new Writable({
      write(chunk, _encoding, callback) {
        chunks.push(Buffer.from(chunk));
        callback();
      }
    })
  );
  return deserialize(Buffer.concat(chunks)) as T;
}

async function writeGzipStream(filePath: string, source: Readable): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  const abortController = new AbortController();
  const timeoutMs = Number.parseInt(process.env.QLI_GZIP_WRITE_STALL_TIMEOUT_MS ?? "120000", 10);
  let timeout: NodeJS.Timeout | undefined;
  const resetTimeout = () => {
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
      return;
    }
    if (timeout) {
      clearTimeout(timeout);
    }
    timeout = setTimeout(() => {
      abortController.abort(new Error(`timed out writing ${filePath}; no gzip output for ${timeoutMs}ms`));
    }, timeoutMs);
  };
  const progress = new Transform({
    transform(chunk, _encoding, callback) {
      resetTimeout();
      callback(null, chunk);
    }
  });
  try {
    resetTimeout();
    await pipeline(source, createGzip(), progress, createWriteStream(temporaryPath), { signal: abortController.signal });
    await rename(temporaryPath, filePath);
  } catch (error) {
    source.destroy();
    await rm(temporaryPath, { force: true });
    throw error;
  } finally {
    if (timeout) {
      clearTimeout(timeout);
    }
  }
}

export async function hashJson(value: unknown): Promise<string> {
  const hash = createHash("sha256");
  hash.update(serialize(value));
  return hash.digest("hex");
}

export async function readJsonFromGzipOrFile<T>(gzipPath: string, legacyPath?: string): Promise<T> {
  if (await fileExists(gzipPath)) {
    return readJsonFile<T>(gzipPath, true);
  }
  if (legacyPath && await fileExists(legacyPath)) {
    return readJsonFile<T>(legacyPath, false);
  }
  throw new Error(`JSON file does not exist: ${gzipPath}`);
}

export async function resolveExistingGzipOrFilePath(gzipPath: string, legacyPath?: string): Promise<string> {
  if (await fileExists(gzipPath)) {
    return gzipPath;
  }
  if (legacyPath && await fileExists(legacyPath)) {
    return legacyPath;
  }
  return gzipPath;
}

function jsonTextStream(value: unknown): Readable {
  const json = JSON.stringify(value);
  if (json === undefined) {
    throw new TypeError("cannot write unsupported JSON value");
  }
  const chunkSize = 1024 * 1024;
  return Readable.from((function* chunks() {
    for (let offset = 0; offset < json.length; offset += chunkSize) {
      yield json.slice(offset, offset + chunkSize);
    }
  })());
}

async function readJsonFile<T>(filePath: string, gzipped: boolean): Promise<T> {
  const input = createReadStream(filePath);
  const stream = gzipped ? input.pipe(createGunzip()) : input;
  const values = stream.pipe(parser.asStream()).pipe(streamValues.asStream()) as AsyncIterable<StreamValuesItem>;
  let found = false;
  let result: T | undefined;
  for await (const item of values) {
    if (found) {
      throw new Error(`expected one JSON value in ${filePath}`);
    }
    found = true;
    result = item.value as T;
  }
  if (!found) {
    throw new Error(`empty JSON file: ${filePath}`);
  }
  return result as T;
}
