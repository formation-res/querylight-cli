import { readFile, writeFile } from "node:fs/promises";
import { promisify } from "node:util";
import { gunzip, gzip } from "node:zlib";
import { fileExists } from "./files.js";

const gzipAsync = promisify(gzip);
const gunzipAsync = promisify(gunzip);

export async function writeGzipJson(filePath: string, value: unknown): Promise<void> {
  const payload = JSON.stringify(value, null, 2);
  await writeFile(filePath, await gzipAsync(Buffer.from(payload, "utf8")));
}

export async function readJsonFromGzipOrFile<T>(gzipPath: string, legacyPath?: string): Promise<T> {
  if (await fileExists(gzipPath)) {
    const payload = await readFile(gzipPath);
    return JSON.parse((await gunzipAsync(payload)).toString("utf8")) as T;
  }
  if (legacyPath && await fileExists(legacyPath)) {
    return JSON.parse(await readFile(legacyPath, "utf8")) as T;
  }
  return JSON.parse(await readFile(gzipPath, "utf8")) as T;
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
