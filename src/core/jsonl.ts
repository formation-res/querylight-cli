import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

export async function readJsonl<T>(filePath: string): Promise<T[]> {
  try {
    const raw = await readFile(filePath, "utf8");
    return raw
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
      .map((line) => JSON.parse(line) as T);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }
    throw error;
  }
}

export async function writeJsonl<T>(filePath: string, records: T[]): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  const payload = records.map((record) => JSON.stringify(record)).join("\n");
  await writeFile(filePath, payload.length > 0 ? `${payload}\n` : "", "utf8");
}
