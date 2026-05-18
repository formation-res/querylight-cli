import matter from "gray-matter";

export function normalizeWhitespace(text: string): string {
  return text
    .replace(/\r\n/g, "\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function withFrontmatter(metadata: Record<string, unknown>, body: string): string {
  return matter.stringify(normalizeWhitespace(body), metadata);
}
