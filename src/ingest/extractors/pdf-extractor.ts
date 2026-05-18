import { readFile } from "node:fs/promises";
import pdf from "pdf-parse";

export async function extractPdf(filePath: string): Promise<string> {
  const buffer = await readFile(filePath);
  const parsed = await pdf(buffer);
  return parsed.text;
}
