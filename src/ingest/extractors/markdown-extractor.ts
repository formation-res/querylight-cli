import { readFile } from "node:fs/promises";

export async function extractMarkdown(filePath: string): Promise<string> {
  return readFile(filePath, "utf8");
}
