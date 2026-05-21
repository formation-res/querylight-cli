import path from "node:path";
import { loadChunks, saveChunks } from "../chunk/chunk-store.js";
import { loadConfig } from "../core/config.js";
import { mapWithConcurrency } from "../core/concurrency.js";
import { fileExists } from "../core/files.js";
import { stableId } from "../core/ids.js";
import { readJsonl, writeJsonl } from "../core/jsonl.js";
import { reportProgress, reportProgressDetail, type ProgressHandler } from "../core/progress.js";
import { writeRun } from "../core/runs.js";
import type { DocumentRecord, RunRecord, Source } from "../types/models.js";
import { listSources } from "../sources/source-store.js";
import { deleteDocumentArtifacts } from "./document-utils.js";
import { listDirectoryFiles } from "./adapters/directory-adapter.js";
import { ingestFile, ingestInlineContent, reprocessStoredDocument } from "./adapters/file-adapter.js";
import { parseRssFeedDocument } from "./adapters/rss-adapter.js";
import { fetchUrlDocument, reprocessRemoteDocument } from "./adapters/url-adapter.js";
import { crawlWebsite } from "./adapters/website-adapter.js";

function documentsFile(workspacePath: string): string {
  return path.join(workspacePath, "documents", "documents.jsonl");
}

async function loadDocuments(workspacePath: string): Promise<DocumentRecord[]> {
  return readJsonl<DocumentRecord>(documentsFile(workspacePath));
}

async function saveDocuments(workspacePath: string, documents: DocumentRecord[]): Promise<void> {
  await writeJsonl(documentsFile(workspacePath), documents.sort((a, b) => a.id.localeCompare(b.id)));
}

function previousMap(documents: DocumentRecord[]): Map<string, DocumentRecord> {
  return new Map(documents.map((document) => [document.id, document]));
}

function nowStamp(): string {
  return new Date().toISOString();
}

function runId(): string {
  return nowStamp().replace(/[:.]/g, "-");
}

function documentSnapshot(documents: DocumentRecord[]): RunRecord["documentsSnapshot"] {
  return documents.map((document) => ({
    id: document.id,
    title: document.title,
    uri: document.uri,
    contentHash: document.contentHash,
    lastChangedAt: document.lastChangedAt,
    sourceId: document.sourceId
  }));
}

function shouldExpireRssDocument(document: DocumentRecord, source: Source, defaultRetentionDays: number): boolean {
  if (source.type !== "rss" || !document.publicationDate) {
    return false;
  }
  const retentionDays = source.crawl?.retentionDays ?? defaultRetentionDays;
  const publishedAt = new Date(document.publicationDate);
  if (Number.isNaN(publishedAt.getTime())) {
    return false;
  }
  const cutoff = Date.now() - retentionDays * 24 * 60 * 60 * 1000;
  return publishedAt.getTime() < cutoff;
}

async function purgeDocuments(
  workspacePath: string,
  documentIds: Set<string>,
  documents: DocumentRecord[]
): Promise<void> {
  if (documentIds.size === 0) {
    return;
  }
  const chunks = await loadChunks(workspacePath);
  const filteredChunks = chunks.filter((chunk) => !documentIds.has(chunk.documentId));
  if (filteredChunks.length !== chunks.length) {
    await saveChunks(workspacePath, filteredChunks);
  }
  await Promise.all(
    documents
      .filter((document) => documentIds.has(document.id))
      .map((document) => deleteDocumentArtifacts(document))
  );
}

async function fetchFeedText(source: Source): Promise<string> {
  const response = await fetch(source.uri, {
    headers: {
      "user-agent": source.crawl?.userAgent ?? "querylight-cli/0.1"
    }
  });
  if (!response.ok) {
    throw new Error(`failed to fetch feed: ${response.status}`);
  }
  return response.text();
}

async function ingestRssSource(
  {
    workspacePath,
    source,
    previous,
    nextDocuments,
    maxConcurrentRequests,
    onDocumentProcessed,
    onFailure
  }: {
    workspacePath: string;
    source: Source;
    previous: Map<string, DocumentRecord>;
    nextDocuments: Map<string, DocumentRecord>;
    maxConcurrentRequests: number;
    onDocumentProcessed?: (uri: string, outcome: "added" | "changed" | "unchanged") => void;
    onFailure: (uri: string, error: unknown) => void;
  }
): Promise<{
  added: number;
  changed: number;
  unchanged: number;
  failed: number;
}> {
  if (source.crawl?.fetchArticles === false) {
    throw new Error("rss sources require article fetching");
  }
  const xml = await fetchFeedText(source);
  const items = await parseRssFeedDocument(xml, source);
  const processedDocumentIds = new Set<string>();
  let added = 0;
  let changed = 0;
  let unchanged = 0;
  let failed = 0;

  await mapWithConcurrency(items, maxConcurrentRequests, async (item) => {
    try {
      const probe = previous.get(stableId("doc", source.id, item.url));
      const document = await fetchUrlDocument({
        workspacePath,
        source,
        url: item.url,
        previous: probe,
        sourceUri: source.uri,
        publicationDate: item.publicationDate
      });
      if (processedDocumentIds.has(document.id)) {
        return;
      }
      processedDocumentIds.add(document.id);
      const existingDocument = probe ?? previous.get(document.id);
      nextDocuments.set(document.id, document);
      if (!existingDocument) {
        added += 1;
        onDocumentProcessed?.(document.uri, "added");
      } else if (existingDocument.contentHash !== document.contentHash) {
        changed += 1;
        onDocumentProcessed?.(document.uri, "changed");
      } else {
        unchanged += 1;
        onDocumentProcessed?.(document.uri, "unchanged");
      }
    } catch (error) {
      failed += 1;
      onFailure(item.url, error);
    }
  });

  return { added, changed, unchanged, failed };
}

export async function ingestSources(
  {
    workspacePath,
    sourceIds,
    changedOnly = false,
    progress
  }: {
    workspacePath: string;
    sourceIds?: string[];
    changedOnly?: boolean;
    progress?: ProgressHandler;
  }
): Promise<{
  runId: string;
  documents: { added: number; changed: number; unchanged: number; failed: number };
  processedSources: number;
}> {
  const config = await loadConfig(workspacePath);
  const defaultRetentionDays = config.crawler.retentionDays;
  const defaultUserAgent = config.crawler.defaultUserAgent;
  const defaultRateLimitMs = config.crawler.rateLimitMs;
  const defaultMaxConcurrentRequests = config.crawler.maxConcurrentRequests;
  const sources = (await listSources(workspacePath)).filter((source) => source.enabled && (!sourceIds || sourceIds.includes(source.id)));
  const existing = await loadDocuments(workspacePath);
  const previous = previousMap(existing);
  const nextDocuments = new Map(existing.map((document) => [document.id, document]));
  let added = 0;
  let changed = 0;
  let unchanged = 0;
  let failed = 0;
  const failures: Array<{ sourceId: string; uri: string; message: string }> = [];

  reportProgress(progress, `Ingesting ${sources.length} source${sources.length === 1 ? "" : "s"}`);

  for (const source of sources) {
    const maxConcurrentRequests = source.crawl?.maxConcurrentRequests ?? defaultMaxConcurrentRequests;
    const sourceBefore = { added, changed, unchanged, failed };
    const processedDocumentIds = new Set<string>();
    const reportDocumentOutcome = (uri: string, outcome: "added" | "changed" | "unchanged"): void => {
      const label = outcome === "unchanged" ? "Unchanged" : outcome === "changed" ? "Updated" : "Added";
      reportProgress(progress, `${label} ${uri}`);
    };
    const ingestOne = async (uri: string, producer: () => Promise<DocumentRecord>): Promise<DocumentRecord | null> => {
      try {
        const probeId = stableId("doc", source.id, uri);
        const earlier = previous.get(probeId);
        const document = await producer();
        if (processedDocumentIds.has(document.id)) {
          reportProgressDetail(progress, `Skipped duplicate alias ${uri} -> ${document.uri}`);
          return null;
        }
        processedDocumentIds.add(document.id);
        const existingDocument = earlier ?? previous.get(document.id);
        nextDocuments.set(document.id, document);
        if (!existingDocument) {
          added += 1;
          reportDocumentOutcome(document.uri, "added");
        } else if (existingDocument.contentHash !== document.contentHash) {
          changed += 1;
          reportDocumentOutcome(document.uri, "changed");
        } else {
          unchanged += 1;
          reportDocumentOutcome(document.uri, "unchanged");
        }
        return document;
      } catch (error) {
        failed += 1;
        failures.push({
          sourceId: source.id,
          uri,
          message: error instanceof Error ? error.message : String(error)
        });
        reportProgressDetail(progress, `Failed ${uri}: ${error instanceof Error ? error.message : String(error)}`);
        return null;
      }
    };

    try {
      reportProgress(progress, `Source ${source.name} (${source.type})`);
      if (source.type === "file") {
        reportProgress(progress, `Reading file ${source.uri}`);
        await ingestOne(source.uri, () => ingestFile({ workspacePath, source, filePath: source.uri, previous: previous.get(stableId("doc", source.id, source.uri)) }));
      } else if (source.type === "directory") {
        const files = await listDirectoryFiles(source);
        reportProgress(progress, `Scanning ${files.length} file${files.length === 1 ? "" : "s"} from ${source.uri}`);
        for (const filePath of files) {
          reportProgress(progress, `Reading file ${filePath}`);
          await ingestOne(filePath, () => ingestFile({ workspacePath, source, filePath, previous: previous.get(stableId("doc", source.id, filePath)) }));
        }
      } else if (source.type === "url") {
        reportProgress(progress, `Fetching ${source.uri}`);
        await ingestOne(source.uri, () => fetchUrlDocument({ workspacePath, source, url: source.uri, previous: previous.get(stableId("doc", source.id, source.uri)) }));
      } else if (source.type === "website") {
        reportProgress(progress, `Crawling ${source.uri}`);
        const urls = await crawlWebsite(source, {
          userAgent: defaultUserAgent,
          rateLimitMs: defaultRateLimitMs,
          maxConcurrentRequests
        }, progress);
        reportProgress(progress, `Fetched ${urls.length} page${urls.length === 1 ? "" : "s"} from crawl`);
        const seenCanonicalUrls = new Set<string>();
        await mapWithConcurrency(urls, maxConcurrentRequests, async (url) => {
          if (seenCanonicalUrls.has(url)) {
            reportProgressDetail(progress, `Skipped canonical duplicate ${url}`);
            return;
          }
          reportProgress(progress, `Fetching ${url}`);
          const document = await ingestOne(url, () => fetchUrlDocument({ workspacePath, source, url, previous: previous.get(stableId("doc", source.id, url)) }));
          if (document) {
            seenCanonicalUrls.add(document.uri);
          }
        });
      } else if (source.type === "rss") {
        reportProgress(progress, `Fetching feed ${source.uri}`);
        const result = await ingestRssSource({
          workspacePath,
          source,
          previous,
          nextDocuments,
          maxConcurrentRequests,
          onDocumentProcessed: reportDocumentOutcome,
          onFailure: (uri, error) => {
            failures.push({
              sourceId: source.id,
              uri,
              message: error instanceof Error ? error.message : String(error)
            });
            reportProgressDetail(progress, `Failed ${uri}: ${error instanceof Error ? error.message : String(error)}`);
          }
        });
        added += result.added;
        changed += result.changed;
        unchanged += result.unchanged;
        failed += result.failed;
      } else if (source.type === "markdown" || source.type === "text") {
        reportProgress(progress, `Processing inline ${source.type} source ${source.id}`);
        await ingestOne(source.uri, () => ingestInlineContent({
          workspacePath,
          source,
          title: source.name,
          content: source.uri,
          uri: `inline:${source.id}`,
          previous: previous.get(stableId("doc", source.id, `inline:${source.id}`))
        }));
      }
    } catch (error) {
      failed += 1;
      failures.push({
        sourceId: source.id,
        uri: source.uri,
        message: error instanceof Error ? error.message : String(error)
      });
      reportProgressDetail(progress, `Failed source ${source.name}: ${error instanceof Error ? error.message : String(error)}`);
    }
    reportProgress(
      progress,
      `Finished ${source.name}: +${added - sourceBefore.added} added, ${changed - sourceBefore.changed} changed, ${unchanged - sourceBefore.unchanged} unchanged, ${failed - sourceBefore.failed} failed`
    );
  }

  const expiringDocuments = [...nextDocuments.values()].filter((document) => {
    const source = sources.find((candidate) => candidate.id === document.sourceId);
    return source ? shouldExpireRssDocument(document, source, defaultRetentionDays) : false;
  });
  if (expiringDocuments.length > 0) {
    reportProgress(progress, `Removing ${expiringDocuments.length} expired RSS document${expiringDocuments.length === 1 ? "" : "s"}`);
    const expiredIds = new Set(expiringDocuments.map((document) => document.id));
    for (const document of expiringDocuments) {
      nextDocuments.delete(document.id);
    }
    await purgeDocuments(workspacePath, expiredIds, [...existing, ...expiringDocuments]);
  }

  const finalDocuments = [...nextDocuments.values()];
  await saveDocuments(workspacePath, finalDocuments);
  const id = runId();
  const run: RunRecord = {
    id,
    kind: "ingest",
    createdAt: nowStamp(),
    success: failed === 0,
    summary: {
      processedSources: sources.length,
      added,
      changed,
      unchanged,
      failed,
      changedOnly
    },
    failures,
    documentsSnapshot: documentSnapshot(finalDocuments)
  };
  await writeRun(workspacePath, run);
  reportProgress(progress, `Ingest complete: ${added} added, ${changed} changed, ${unchanged} unchanged, ${failed} failed`);
  return {
    runId: id,
    documents: { added, changed, unchanged, failed },
    processedSources: sources.length
  };
}

export async function reprocessDocuments(
  {
    workspacePath,
    sourceId,
    documentId,
    progress
  }: {
    workspacePath: string;
    sourceId?: string;
    documentId?: string;
    progress?: ProgressHandler;
  }
): Promise<{ runId: string; documentsReprocessed: number; documentsSkipped: number }> {
  const documents = await loadDocuments(workspacePath);
  const sources = await listSources(workspacePath);
  const sourceMap = new Map(sources.map((source) => [source.id, source]));
  const nextDocuments = new Map(documents.map((document) => [document.id, document]));
  let documentsReprocessed = 0;
  let documentsSkipped = 0;
  const targets = documents.filter((candidate) => (!sourceId || candidate.sourceId === sourceId) && (!documentId || candidate.id === documentId));

  reportProgress(progress, `Reprocessing ${targets.length} document${targets.length === 1 ? "" : "s"}`);

  for (const document of targets) {
    reportProgressDetail(progress, `Reprocessing ${document.id} (${document.title})`);
    const source = sourceMap.get(document.sourceId);
    if (!source || !document.rawPath || !await fileExists(document.rawPath)) {
      documentsSkipped += 1;
      reportProgressDetail(progress, `Skipped ${document.id}: raw source not available`);
      continue;
    }

    const updated = source.type === "url" || source.type === "website" || source.type === "rss"
      ? await reprocessRemoteDocument(document, source)
      : await reprocessStoredDocument(document, source);

    if (!updated) {
      documentsSkipped += 1;
      reportProgressDetail(progress, `Skipped ${document.id}: source type could not be reprocessed`);
      continue;
    }
    nextDocuments.set(updated.id, updated);
    documentsReprocessed += 1;
  }

  const finalDocuments = [...nextDocuments.values()];
  await saveDocuments(workspacePath, finalDocuments);
  const id = runId();
  await writeRun(workspacePath, {
    id,
    kind: "reprocess",
    createdAt: nowStamp(),
    success: true,
    summary: {
      documentsReprocessed,
      documentsSkipped
    },
    documentsSnapshot: documentSnapshot(finalDocuments)
  });
  reportProgress(progress, `Reprocess complete: ${documentsReprocessed} updated, ${documentsSkipped} skipped`);
  return { runId: id, documentsReprocessed, documentsSkipped };
}
