import { readFile } from "node:fs/promises";

export async function extractText(filePath: string): Promise<string> {
  return readFile(filePath, "utf8");
}
