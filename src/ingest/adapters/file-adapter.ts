import { basename, extname, resolve } from "node:path";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import type { DocumentRecord, Source } from "../../types/models.js";
import { sha256 } from "../../core/hashing.js";
import { stableId } from "../../core/ids.js";
import { extractDocx } from "../extractors/docx-extractor.js";
import { extractHtmlToMarkdown } from "../extractors/html-extractor.js";
import { extractMarkdown } from "../extractors/markdown-extractor.js";
import { extractPdf } from "../extractors/pdf-extractor.js";
import { extractText } from "../extractors/text-extractor.js";
import { buildDocumentMetadata, writeNormalizedDocument } from "../document-utils.js";

function mimeTypeFor(filePath: string): string {
  const ext = extname(filePath).toLowerCase();
  switch (ext) {
    case ".md":
      return "text/markdown";
    case ".txt":
      return "text/plain";
    case ".html":
    case ".htm":
      return "text/html";
    case ".pdf":
      return "application/pdf";
    case ".docx":
      return "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
    default:
      return "application/octet-stream";
  }
}

async function extractFileContent(filePath: string, mimeType: string): Promise<{ title: string; markdown: string; raw?: string }> {
  if (mimeType === "text/markdown") {
    const markdown = await extractMarkdown(filePath);
    const title = markdown.match(/^#\s+(.+)$/m)?.[1]?.trim() ?? basename(filePath);
    return { title, markdown, raw: markdown };
  }
  if (mimeType === "text/plain") {
    const text = await extractText(filePath);
    return { title: basename(filePath), markdown: `# ${basename(filePath)}\n\n${text}`, raw: text };
  }
  if (mimeType === "text/html") {
    const raw = await readFile(filePath, "utf8");
    const extracted = extractHtmlToMarkdown(raw);
    return { title: extracted.title, markdown: `# ${extracted.title}\n\n${extracted.markdown}`, raw };
  }
  if (mimeType === "application/pdf") {
    const text = await extractPdf(filePath);
    return { title: basename(filePath), markdown: `# ${basename(filePath)}\n\n${text}` };
  }
  if (mimeType.includes("wordprocessingml")) {
    const text = await extractDocx(filePath);
    return { title: basename(filePath), markdown: `# ${basename(filePath)}\n\n${text}` };
  }
  throw new Error(`unsupported file type: ${mimeType}`);
}

async function extractRawContent(raw: string, mimeType: string, fallbackTitle: string): Promise<{ title: string; markdown: string }> {
  if (mimeType === "text/markdown") {
    const title = raw.match(/^#\s+(.+)$/m)?.[1]?.trim() ?? fallbackTitle;
    return { title, markdown: raw };
  }
  if (mimeType === "text/plain") {
    return { title: fallbackTitle, markdown: `# ${fallbackTitle}\n\n${raw}` };
  }
  if (mimeType === "text/html") {
    const extracted = extractHtmlToMarkdown(raw);
    return { title: extracted.title, markdown: `# ${extracted.title}\n\n${extracted.markdown}` };
  }
  throw new Error(`raw reprocessing is not supported for ${mimeType}`);
}

export async function ingestFile(
  {
    workspacePath,
    source,
    filePath,
    previous
  }: {
    workspacePath: string;
    source: Source;
    filePath: string;
    previous?: DocumentRecord;
  }
): Promise<DocumentRecord> {
  const resolved = resolve(filePath);
  const fileStat = await stat(resolved);
  const mimeType = mimeTypeFor(resolved);
  const extracted = await extractFileContent(resolved, mimeType);
  const documentId = stableId("doc", source.id, resolved);
  const normalizedPath = resolve(workspacePath, "normalized", `${documentId}.md`);
  const rawPath = resolve(workspacePath, "raw", source.id, basename(resolved));
  const contentHash = sha256(extracted.markdown);
  const now = new Date().toISOString();
  const lastChangedAt = previous?.contentHash === contentHash ? previous.lastChangedAt : now;
  const indexedAt = now;
  const crawledAt = now;
  await mkdir(resolve(workspacePath, "normalized"), { recursive: true });
  await mkdir(resolve(workspacePath, "raw", source.id), { recursive: true });
  if (extracted.raw) {
    await writeFile(rawPath, extracted.raw, "utf8");
  }
  await writeNormalizedDocument({
    documentId,
    sourceId: source.id,
    title: extracted.title,
    uri: resolved,
    sourceUri: source.uri,
    publicationDate: previous?.publicationDate ?? null,
    crawledAt,
    indexedAt,
    contentHash,
    lastChangedAt,
    normalizedPath,
    markdown: extracted.markdown
  });
  return {
    id: documentId,
    sourceId: source.id,
    sourceType: source.type,
    title: extracted.title,
    uri: resolved,
    sourceUri: source.uri,
    mimeType,
    rawPath: extracted.raw ? rawPath : undefined,
    normalizedPath,
    contentHash,
    metadata: buildDocumentMetadata({
      source,
      sourceUri: source.uri,
      publicationDate: previous?.publicationDate ?? null,
      crawledAt,
      indexedAt,
      extra: {
        contentType: mimeType,
        fileSizeBytes: fileStat.size
      }
    }),
    publicationDate: previous?.publicationDate ?? null,
    crawledAt,
    firstSeenAt: previous?.firstSeenAt ?? now,
    lastSeenAt: now,
    lastChangedAt,
    indexedAt
  };
}

export async function ingestInlineContent(
  {
    workspacePath,
    source,
    content,
    title,
    uri,
    previous
  }: {
    workspacePath: string;
    source: Source;
    content: string;
    title: string;
    uri: string;
    previous?: DocumentRecord;
  }
): Promise<DocumentRecord> {
  const markdown = source.type === "markdown" ? content : `# ${title}\n\n${content}`;
  const documentId = stableId("doc", source.id, uri);
  const normalizedPath = resolve(workspacePath, "normalized", `${documentId}.md`);
  const contentHash = sha256(markdown);
  const now = new Date().toISOString();
  const lastChangedAt = previous?.contentHash === contentHash ? previous.lastChangedAt : now;
  const indexedAt = now;
  await mkdir(resolve(workspacePath, "normalized"), { recursive: true });
  await writeNormalizedDocument({
    documentId,
    sourceId: source.id,
    title,
    uri,
    sourceUri: source.uri,
    publicationDate: previous?.publicationDate ?? null,
    crawledAt: now,
    indexedAt,
    contentHash,
    lastChangedAt,
    normalizedPath,
    markdown
  });
  return {
    id: documentId,
    sourceId: source.id,
    sourceType: source.type,
    title,
    uri,
    sourceUri: source.uri,
    mimeType: source.type === "markdown" ? "text/markdown" : "text/plain",
    normalizedPath,
    contentHash,
    metadata: buildDocumentMetadata({
      source,
      sourceUri: source.uri,
      publicationDate: previous?.publicationDate ?? null,
      crawledAt: now,
      indexedAt
    }),
    publicationDate: previous?.publicationDate ?? null,
    crawledAt: now,
    firstSeenAt: previous?.firstSeenAt ?? now,
    lastSeenAt: now,
    lastChangedAt,
    indexedAt
  };
}

export async function reprocessStoredDocument(
  document: DocumentRecord,
  source: Source
): Promise<DocumentRecord | null> {
  if (!document.rawPath) {
    return null;
  }
  const raw = await readFile(document.rawPath, "utf8");
  const fallbackTitle = document.title || basename(document.uri);
  const extracted = await extractRawContent(raw, document.mimeType, fallbackTitle);
  const contentHash = sha256(extracted.markdown);
  const now = new Date().toISOString();
  const indexedAt = now;
  const lastChangedAt = document.contentHash === contentHash ? document.lastChangedAt : now;
  await writeNormalizedDocument({
    documentId: document.id,
    sourceId: document.sourceId,
    title: extracted.title,
    uri: document.uri,
    sourceUri: document.sourceUri,
    publicationDate: document.publicationDate ?? null,
    crawledAt: document.crawledAt,
    indexedAt,
    contentHash,
    lastChangedAt,
    normalizedPath: document.normalizedPath,
    markdown: extracted.markdown
  });
  return {
    ...document,
    title: extracted.title,
    contentHash,
    metadata: buildDocumentMetadata({
      source,
      sourceUri: document.sourceUri,
      publicationDate: document.publicationDate ?? null,
      crawledAt: document.crawledAt,
      indexedAt,
      extra: {
        ...document.metadata,
        contentType: document.mimeType
      }
    }),
    lastChangedAt,
    indexedAt
  };
}
