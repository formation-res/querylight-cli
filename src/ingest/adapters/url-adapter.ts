import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { DocumentRecord, HttpCacheMetadata, Source } from "../../types/models.js";
import { fileExists } from "../../core/files.js";
import { sha256 } from "../../core/hashing.js";
import { stableId } from "../../core/ids.js";
import { normalizeRemoteUrl } from "../../core/urls.js";
import { buildDocumentMetadata, writeNormalizedDocument } from "../document-utils.js";
import { extractCanonicalUriFromHtml, extractHtmlToMarkdown, extractPublicationDateFromHtml } from "../extractors/html-extractor.js";

export type FetchRemoteDocumentOptions = {
  workspacePath: string;
  source: Source;
  url: string;
  previous?: DocumentRecord;
  sourceUri?: string;
  publicationDate?: string | null;
};

function buildHttpCache(response: Response, validatedAt: string): HttpCacheMetadata {
  return {
    etag: response.headers.get("etag") ?? undefined,
    lastModified: response.headers.get("last-modified") ?? undefined,
    cacheControl: response.headers.get("cache-control") ?? undefined,
    expires: response.headers.get("expires"),
    lastValidatedAt: validatedAt,
    lastStatus: response.status
  };
}

function choosePublicationDate(
  preferred?: string | null,
  fallback?: string | null,
  previous?: string | null
): string | null {
  return preferred ?? fallback ?? previous ?? null;
}

async function normalizeRemoteDocument(
  {
    workspacePath,
    source,
    url,
    body,
    previous,
    sourceUri,
    publicationDate,
    responseStatus
  }: {
    workspacePath: string;
    source: Source;
    url: string;
    body: string;
    previous?: DocumentRecord;
    sourceUri: string;
    publicationDate?: string | null;
    responseStatus: number;
  }
): Promise<DocumentRecord> {
  const extracted = extractHtmlToMarkdown(body);
  const canonicalUri = normalizeRemoteUrl(extractCanonicalUriFromHtml(body, url) ?? url);
  const markdown = `# ${extracted.title}\n\n${extracted.markdown}`;
  const documentId = stableId("doc", source.id, canonicalUri);
  const normalizedPath = path.resolve(workspacePath, "normalized", `${documentId}.md`);
  const rawPath = path.resolve(workspacePath, "raw", source.id, `${sha256(canonicalUri).slice(0, 12)}.html`);
  const contentHash = sha256(markdown);
  const now = new Date().toISOString();
  const lastChangedAt = previous?.contentHash === contentHash ? previous.lastChangedAt : now;
  const indexedAt = now;
  const crawledAt = now;
  const resolvedPublicationDate = choosePublicationDate(publicationDate, extractPublicationDateFromHtml(body), previous?.publicationDate);

  await mkdir(path.resolve(workspacePath, "raw", source.id), { recursive: true });
  await writeFile(rawPath, body, "utf8");
  await writeNormalizedDocument({
    documentId,
    sourceId: source.id,
    title: extracted.title,
    uri: canonicalUri,
    sourceUri,
    publicationDate: resolvedPublicationDate,
    crawledAt,
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
    title: extracted.title,
    uri: canonicalUri,
    sourceUri,
    canonicalUri,
    mimeType: "text/html",
    rawPath,
    normalizedPath,
    contentHash,
    metadata: buildDocumentMetadata({
      source,
      sourceUri,
      publicationDate: resolvedPublicationDate,
      crawledAt,
      indexedAt,
      extra: {
        status: responseStatus,
        contentType: "text/html"
      }
    }),
    publicationDate: resolvedPublicationDate,
    crawledAt,
    firstSeenAt: previous?.firstSeenAt ?? now,
    lastSeenAt: now,
    lastChangedAt,
    indexedAt
  };
}

export async function fetchUrlDocument(
  {
    workspacePath,
    source,
    url,
    previous,
    sourceUri,
    publicationDate
  }: FetchRemoteDocumentOptions
): Promise<DocumentRecord> {
  const headers: Record<string, string> = {
    "user-agent": source.crawl?.userAgent ?? "querylight-cli/0.1"
  };
  if (previous?.httpCache?.etag) {
    headers["if-none-match"] = previous.httpCache.etag;
  }
  if (previous?.httpCache?.lastModified) {
    headers["if-modified-since"] = previous.httpCache.lastModified;
  }

  const response = await fetch(url, { headers });
  const now = new Date().toISOString();
  const nextHttpCache = buildHttpCache(response, now);
  const effectiveSourceUri = sourceUri ?? source.uri;

  if (response.status === 304 && previous?.rawPath && await fileExists(previous.rawPath) && await fileExists(previous.normalizedPath)) {
    return {
      ...previous,
      sourceUri: effectiveSourceUri,
      publicationDate: publicationDate ?? previous.publicationDate ?? null,
      metadata: buildDocumentMetadata({
        source,
        sourceUri: effectiveSourceUri,
        publicationDate: publicationDate ?? previous.publicationDate ?? null,
        crawledAt: previous.crawledAt,
        indexedAt: previous.indexedAt,
        extra: {
          ...previous.metadata,
          status: previous.metadata.status ?? 200,
          contentType: previous.mimeType
        }
      }),
      lastSeenAt: now,
      httpCache: nextHttpCache
    };
  }

  const body = await response.text();
  const document = await normalizeRemoteDocument({
    workspacePath,
    source,
    url,
    body,
    previous,
    sourceUri: effectiveSourceUri,
    publicationDate,
    responseStatus: response.status
  });
  return {
    ...document,
    mimeType: response.headers.get("content-type") ?? document.mimeType,
    metadata: buildDocumentMetadata({
      source,
      sourceUri: effectiveSourceUri,
      publicationDate: document.publicationDate ?? null,
      crawledAt: document.crawledAt,
      indexedAt: document.indexedAt,
      extra: {
        status: response.status,
        contentType: response.headers.get("content-type") ?? document.mimeType
      }
    }),
    httpCache: nextHttpCache
  };
}

export async function reprocessRemoteDocument(
  document: DocumentRecord,
  source: Source
): Promise<DocumentRecord | null> {
  if (!document.rawPath || !await fileExists(document.rawPath)) {
    return null;
  }
  const raw = await readFile(document.rawPath, "utf8");
  const extracted = extractHtmlToMarkdown(raw);
  const markdown = `# ${extracted.title}\n\n${extracted.markdown}`;
  const contentHash = sha256(markdown);
  const now = new Date().toISOString();
  const indexedAt = now;
  const lastChangedAt = document.contentHash === contentHash ? document.lastChangedAt : now;
  const publicationDate = document.publicationDate ?? extractPublicationDateFromHtml(raw);
  await writeNormalizedDocument({
    documentId: document.id,
    sourceId: document.sourceId,
    title: extracted.title,
    uri: document.uri,
    sourceUri: document.sourceUri,
    publicationDate,
    crawledAt: document.crawledAt,
    indexedAt,
    contentHash,
    lastChangedAt,
    normalizedPath: document.normalizedPath,
    markdown
  });
  return {
    ...document,
    title: extracted.title,
    contentHash,
    publicationDate,
    metadata: buildDocumentMetadata({
      source,
      sourceUri: document.sourceUri,
      publicationDate,
      crawledAt: document.crawledAt,
      indexedAt,
      extra: {
        ...document.metadata,
        status: document.httpCache?.lastStatus ?? document.metadata.status ?? 200,
        contentType: document.mimeType
      }
    }),
    lastChangedAt,
    indexedAt
  };
}
