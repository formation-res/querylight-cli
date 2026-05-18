import path from "node:path";
import { loadChunks, saveChunks } from "../chunk/chunk-store.js";
import { loadConfig } from "../core/config.js";
import { fileExists } from "../core/files.js";
import { stableId } from "../core/ids.js";
import { readJsonl, writeJsonl } from "../core/jsonl.js";
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
    onFailure
  }: {
    workspacePath: string;
    source: Source;
    previous: Map<string, DocumentRecord>;
    nextDocuments: Map<string, DocumentRecord>;
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
  let added = 0;
  let changed = 0;
  let unchanged = 0;
  let failed = 0;

  for (const item of items) {
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
      nextDocuments.set(document.id, document);
      if (!probe) {
        added += 1;
      } else if (probe.contentHash !== document.contentHash) {
        changed += 1;
      } else {
        unchanged += 1;
      }
    } catch (error) {
      failed += 1;
      onFailure(item.url, error);
    }
  }

  return { added, changed, unchanged, failed };
}

export async function ingestSources(
  {
    workspacePath,
    sourceIds,
    changedOnly = false
  }: {
    workspacePath: string;
    sourceIds?: string[];
    changedOnly?: boolean;
  }
): Promise<{
  runId: string;
  documents: { added: number; changed: number; unchanged: number; failed: number };
  processedSources: number;
}> {
  const config = await loadConfig(workspacePath);
  const defaultRetentionDays = config.crawler.retentionDays;
  const sources = (await listSources(workspacePath)).filter((source) => source.enabled && (!sourceIds || sourceIds.includes(source.id)));
  const existing = await loadDocuments(workspacePath);
  const previous = previousMap(existing);
  const nextDocuments = new Map(existing.map((document) => [document.id, document]));
  let added = 0;
  let changed = 0;
  let unchanged = 0;
  let failed = 0;
  const failures: Array<{ sourceId: string; uri: string; message: string }> = [];

  for (const source of sources) {
    const ingestOne = async (uri: string, producer: () => Promise<DocumentRecord>): Promise<void> => {
      try {
        const probeId = stableId("doc", source.id, uri);
        const earlier = previous.get(probeId);
        const document = await producer();
        nextDocuments.set(document.id, document);
        if (!earlier) {
          added += 1;
        } else if (earlier.contentHash !== document.contentHash) {
          changed += 1;
        } else {
          unchanged += 1;
        }
      } catch (error) {
        failed += 1;
        failures.push({
          sourceId: source.id,
          uri,
          message: error instanceof Error ? error.message : String(error)
        });
      }
    };

    try {
      if (source.type === "file") {
        await ingestOne(source.uri, () => ingestFile({ workspacePath, source, filePath: source.uri, previous: previous.get(stableId("doc", source.id, source.uri)) }));
        continue;
      }
      if (source.type === "directory") {
        for (const filePath of await listDirectoryFiles(source)) {
          await ingestOne(filePath, () => ingestFile({ workspacePath, source, filePath, previous: previous.get(stableId("doc", source.id, filePath)) }));
        }
        continue;
      }
      if (source.type === "url") {
        await ingestOne(source.uri, () => fetchUrlDocument({ workspacePath, source, url: source.uri, previous: previous.get(stableId("doc", source.id, source.uri)) }));
        continue;
      }
      if (source.type === "website") {
        for (const url of await crawlWebsite(source)) {
          await ingestOne(url, () => fetchUrlDocument({ workspacePath, source, url, previous: previous.get(stableId("doc", source.id, url)) }));
        }
        continue;
      }
      if (source.type === "rss") {
        const result = await ingestRssSource({
          workspacePath,
          source,
          previous,
          nextDocuments,
          onFailure: (uri, error) => {
            failures.push({
              sourceId: source.id,
              uri,
              message: error instanceof Error ? error.message : String(error)
            });
          }
        });
        added += result.added;
        changed += result.changed;
        unchanged += result.unchanged;
        failed += result.failed;
        continue;
      }
      if (source.type === "markdown" || source.type === "text") {
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
    }
  }

  const expiringDocuments = [...nextDocuments.values()].filter((document) => {
    const source = sources.find((candidate) => candidate.id === document.sourceId);
    return source ? shouldExpireRssDocument(document, source, defaultRetentionDays) : false;
  });
  if (expiringDocuments.length > 0) {
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
    documentId
  }: {
    workspacePath: string;
    sourceId?: string;
    documentId?: string;
  }
): Promise<{ runId: string; documentsReprocessed: number; documentsSkipped: number }> {
  const documents = await loadDocuments(workspacePath);
  const sources = await listSources(workspacePath);
  const sourceMap = new Map(sources.map((source) => [source.id, source]));
  const nextDocuments = new Map(documents.map((document) => [document.id, document]));
  let documentsReprocessed = 0;
  let documentsSkipped = 0;

  for (const document of documents.filter((candidate) => (!sourceId || candidate.sourceId === sourceId) && (!documentId || candidate.id === documentId))) {
    const source = sourceMap.get(document.sourceId);
    if (!source || !document.rawPath || !await fileExists(document.rawPath)) {
      documentsSkipped += 1;
      continue;
    }

    const updated = source.type === "url" || source.type === "website" || source.type === "rss"
      ? await reprocessRemoteDocument(document, source)
      : await reprocessStoredDocument(document, source);

    if (!updated) {
      documentsSkipped += 1;
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
  return { runId: id, documentsReprocessed, documentsSkipped };
}
