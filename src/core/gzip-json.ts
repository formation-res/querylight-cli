import { createReadStream, createWriteStream } from "node:fs";
import { createHash } from "node:crypto";
import { mkdir, rename, rm } from "node:fs/promises";
import { Readable } from "node:stream";
import { Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createGzip, createGunzip } from "node:zlib";
import path from "node:path";
import { deserialize, serialize } from "node:v8";
import { parser } from "stream-json";
import disassembler from "stream-json/disassembler.js";
import stringer from "stream-json/stringer.js";
import { streamValues, type StreamValuesItem } from "stream-json/streamers/stream-values.js";
import { fileExists } from "./files.js";

export async function writeGzipJson(filePath: string, value: unknown): Promise<void> {
  await writeGzipStream(filePath, jsonStringStream(value));
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
  try {
    await pipeline(source, createGzip(), createWriteStream(temporaryPath));
    await rename(temporaryPath, filePath);
  } catch (error) {
    await rm(temporaryPath, { force: true });
    throw error;
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

function jsonStringStream(value: unknown): Readable {
  return Readable.from([value]).pipe(disassembler.asStream()).pipe(stringer.asStream());
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
