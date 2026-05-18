import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { DocumentRecord, Source } from "../../types/models.js";
import { sha256 } from "../../core/hashing.js";
import { stableId } from "../../core/ids.js";
import { withFrontmatter } from "../../normalize/normalize-markdown.js";
import { extractHtmlToMarkdown } from "../extractors/html-extractor.js";

export async function fetchUrlDocument(
  {
    workspacePath,
    source,
    url,
    previous
  }: {
    workspacePath: string;
    source: Source;
    url: string;
    previous?: DocumentRecord;
  }
): Promise<DocumentRecord> {
  const response = await fetch(url, {
    headers: {
      "user-agent": source.crawl?.userAgent ?? "querylight-cli/0.1"
    }
  });
  const body = await response.text();
  const contentType = response.headers.get("content-type") ?? "text/html";
  const extracted = extractHtmlToMarkdown(body);
  const markdown = `# ${extracted.title}\n\n${extracted.markdown}`;
  const documentId = stableId("doc", source.id, url);
  const normalizedPath = path.resolve(workspacePath, "normalized", `${documentId}.md`);
  const rawPath = path.resolve(workspacePath, "raw", source.id, `${sha256(url).slice(0, 12)}.html`);
  const contentHash = sha256(markdown);
  const now = new Date().toISOString();
  await mkdir(path.resolve(workspacePath, "normalized"), { recursive: true });
  await mkdir(path.resolve(workspacePath, "raw", source.id), { recursive: true });
  await writeFile(rawPath, body, "utf8");
  await writeFile(
    normalizedPath,
    withFrontmatter({ documentId, sourceId: source.id, title: extracted.title, uri: url, contentHash, lastChangedAt: now }, markdown),
    "utf8"
  );
  return {
    id: documentId,
    sourceId: source.id,
    sourceType: source.type,
    title: extracted.title,
    uri: url,
    mimeType: contentType,
    rawPath,
    normalizedPath,
    contentHash,
    metadata: {
      ...source.metadata,
      tags: source.tags,
      status: response.status
    },
    firstSeenAt: previous?.firstSeenAt ?? now,
    lastSeenAt: now,
    lastChangedAt: previous?.contentHash === contentHash ? previous.lastChangedAt : now
  };
}
