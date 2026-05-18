import fg from "fast-glob";
import path from "node:path";
import type { Source } from "../../types/models.js";

export async function listDirectoryFiles(source: Source): Promise<string[]> {
  const include = source.crawl?.includePatterns?.length ? source.crawl.includePatterns : ["**/*.md", "**/*.txt", "**/*.html", "**/*.htm", "**/*.pdf", "**/*.docx"];
  const exclude = source.crawl?.excludePatterns ?? [];
  const matches = await fg(include, {
    cwd: source.uri,
    absolute: true,
    onlyFiles: true,
    dot: false,
    unique: true,
    ignore: exclude,
    followSymbolicLinks: false
  });
  return matches.map((match) => path.resolve(match)).sort();
}
