import { Analyzer, DateFieldIndex, DocumentIndex, KeywordTokenizer, LowerCaseTextFilter, RankingAlgorithm, StoredSourceIndex, TextFieldIndex, type FieldIndex } from "@tryformation/querylight-ts";
import path from "node:path";
import { loadConfig } from "../core/config.js";
import { sha256 } from "../core/hashing.js";
import { readJsonl } from "../core/jsonl.js";
import { reportProgress, reportProgressDetail, type ProgressHandler } from "../core/progress.js";
import type { ChunkRecord, DocumentRecord, IndexMetadata, Source } from "../types/models.js";
import { buildVectorArtifacts } from "../vector/service.js";
import { writeIndexArtifacts } from "./index-store.js";

function keywordFieldIndex(): TextFieldIndex {
  const analyzer = new Analyzer([new LowerCaseTextFilter()], new KeywordTokenizer());
  return new TextFieldIndex(analyzer, analyzer, RankingAlgorithm.BM25);
}

export function createIndexMapping(extraFields: string[] = []): Record<string, FieldIndex> {
  const lexical = new TextFieldIndex(undefined, undefined, RankingAlgorithm.BM25);
  const mapping: Record<string, FieldIndex> = {
    _source: new StoredSourceIndex(),
    text: lexical,
    title: new TextFieldIndex(undefined, undefined, RankingAlgorithm.BM25),
    uri: keywordFieldIndex(),
    sourceId: keywordFieldIndex(),
    sourceName: keywordFieldIndex(),
    tags: keywordFieldIndex(),
    sourceType: keywordFieldIndex(),
    publicationDate: new DateFieldIndex(),
    firstSeenAt: new DateFieldIndex(),
    lastSeenAt: new DateFieldIndex(),
    lastChangedAt: new DateFieldIndex(),
    crawledAt: new DateFieldIndex()
  };
  for (const field of extraFields) {
    mapping[field] = keywordFieldIndex();
  }
  return mapping;
}

function flattenMetadata(metadata: Record<string, unknown>): Record<string, string[]> {
  const flattened: Record<string, string[]> = {};
  for (const [key, value] of Object.entries(metadata)) {
    if (value == null) {
      continue;
    }
    const field = `metadata.${key}`;
    if (Array.isArray(value)) {
      flattened[field] = value.map((item) => String(item).toLowerCase());
    } else {
      flattened[field] = [String(value).toLowerCase()];
    }
  }
  return flattened;
}

export async function buildIndex(
  {
    workspacePath,
    denseOverride,
    sparseOverride,
    buildAvailableModels = false,
    progress
  }: {
    workspacePath: string;
    denseOverride?: boolean;
    sparseOverride?: boolean;
    buildAvailableModels?: boolean;
    progress?: ProgressHandler;
  }
): Promise<{ metadata: IndexMetadata; indexPath: string; denseBuilt: boolean; sparseBuilt: boolean }> {
  const config = await loadConfig(workspacePath);
  reportProgress(progress, "Loading documents, chunks, and sources");
  const chunks = await readJsonl<ChunkRecord>(path.join(workspacePath, "chunks", "chunks.jsonl"));
  const documents = await readJsonl<DocumentRecord>(path.join(workspacePath, "documents", "documents.jsonl"));
  const sources = await readJsonl<Source>(path.join(workspacePath, "sources", "sources.jsonl"));
  const metadataFields = [...new Set(chunks.flatMap((chunk) => Object.keys(chunk.metadata).map((key) => `metadata.${key}`)))];
  const index = new DocumentIndex(createIndexMapping(metadataFields));
  const documentsById = new Map(documents.map((document) => [document.id, document]));
  const sourcesById = new Map(sources.map((source) => [source.id, source]));
  reportProgress(progress, `Building lexical index from ${chunks.length} chunk${chunks.length === 1 ? "" : "s"}`);

  for (const chunk of chunks) {
    const document = documentsById.get(chunk.documentId);
    const source = sourcesById.get(chunk.sourceId);
    index.index({
      id: chunk.id,
      fields: {
        text: [chunk.text],
        title: [chunk.title],
        uri: [chunk.uri.toLowerCase()],
        sourceId: [chunk.sourceId.toLowerCase()],
        sourceName: source ? [source.name.toLowerCase()] : [],
        tags: Array.isArray(chunk.metadata.tags) ? chunk.metadata.tags.map((tag) => String(tag).toLowerCase()) : [],
        sourceType: [String(chunk.metadata.sourceType ?? "").toLowerCase()],
        publicationDate: document?.publicationDate ? [document.publicationDate] : [],
        firstSeenAt: [document?.firstSeenAt ?? chunk.firstSeenAt],
        lastSeenAt: [document?.lastSeenAt ?? chunk.lastSeenAt],
        lastChangedAt: [document?.lastChangedAt ?? chunk.lastChangedAt],
        crawledAt: document?.crawledAt ? [document.crawledAt] : [],
        ...flattenMetadata(chunk.metadata)
      },
      source: {
        chunkId: chunk.id,
        documentId: chunk.documentId,
        sourceId: chunk.sourceId,
        sourceType: document?.sourceType ?? "text",
        sourceName: source?.name,
        title: chunk.title,
        uri: chunk.uri,
        headingPath: chunk.headingPath,
        text: chunk.text,
        normalizedPath: document?.normalizedPath,
        publicationDate: document?.publicationDate ?? null,
        crawledAt: document?.crawledAt,
        firstSeenAt: document?.firstSeenAt ?? chunk.firstSeenAt,
        lastSeenAt: document?.lastSeenAt ?? chunk.lastSeenAt,
        lastChangedAt: document?.lastChangedAt ?? chunk.lastChangedAt,
        metadata: chunk.metadata
      }
    });
  }
  reportProgressDetail(progress, `Indexed ${documents.length} document${documents.length === 1 ? "" : "s"} across ${sources.length} source${sources.length === 1 ? "" : "s"}`);

  const createdAt = new Date().toISOString();
  const metadata: IndexMetadata = {
    id: `index_${createdAt.replace(/[:.]/g, "-")}`,
    createdAt,
    querylightVersion: "0.11.0",
    kbVersion: "0.1.0",
    documentCount: documents.length,
    chunkCount: chunks.length,
    sourceCount: sources.length,
    fields: Object.keys(index.mapping),
    indexHash: sha256(JSON.stringify(index.indexState))
  };
  reportProgress(progress, "Writing lexical index artifacts");
  const artifacts = await writeIndexArtifacts({ workspacePath, indexState: index.indexState, metadata });
  const vectors = await buildVectorArtifacts({
    workspacePath,
    config,
    denseOverride,
    sparseOverride,
    buildAvailableModels,
    progress
  });
  reportProgress(progress, `Index build complete: dense=${Boolean(vectors.dense)}, sparse=${Boolean(vectors.sparse)}`);
  return {
    metadata,
    indexPath: artifacts.indexPath,
    denseBuilt: Boolean(vectors.dense),
    sparseBuilt: Boolean(vectors.sparse)
  };
}
