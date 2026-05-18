import path from "node:path";
import { readJsonl, writeJsonl } from "../core/jsonl.js";
import { stableId } from "../core/ids.js";
import { writeRun } from "../core/runs.js";
import type { DocumentRecord, RunRecord, Source } from "../types/models.js";
import { listSources } from "../sources/source-store.js";
import { listDirectoryFiles } from "./adapters/directory-adapter.js";
import { ingestFile, ingestInlineContent } from "./adapters/file-adapter.js";
import { fetchUrlDocument } from "./adapters/url-adapter.js";
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
  }

  const finalDocuments = [...nextDocuments.values()];
  await saveDocuments(workspacePath, finalDocuments);
  const runId = new Date().toISOString().replace(/[:.]/g, "-");
  const run: RunRecord = {
    id: runId,
    kind: "ingest",
    createdAt: new Date().toISOString(),
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
    documentsSnapshot: finalDocuments.map((document) => ({
      id: document.id,
      title: document.title,
      uri: document.uri,
      contentHash: document.contentHash,
      lastChangedAt: document.lastChangedAt,
      sourceId: document.sourceId
    }))
  };
  await writeRun(workspacePath, run);
  return {
    runId,
    documents: { added, changed, unchanged, failed },
    processedSources: sources.length
  };
}
