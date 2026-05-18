import { BoolQuery, MatchQuery, OP, TermQuery, reciprocalRankFusion, type DocumentIndex } from "@tryformation/querylight-ts";
import path from "node:path";
import { loadConfig } from "../core/config.js";
import { CliError, ExitCode } from "../core/errors.js";
import { fileExists } from "../core/files.js";
import { readJsonl } from "../core/jsonl.js";
import type { ChunkRecord, RetrievalMode, SearchResponseData, SearchResult, WorkspaceConfig } from "../types/models.js";
import { readLatestIndexState } from "../index/index-store.js";
import { createIndexMapping } from "../index/querylight-indexer.js";
import { denseQuery } from "../vector/dense.js";
import { sparseQuery } from "../vector/sparse.js";
import { denseVectorPath, sparseVectorPath } from "../vector/store.js";

async function loadHydratedIndex(workspacePath: string): Promise<DocumentIndex> {
  const state = await readLatestIndexState(workspacePath);
  const mapping = createIndexMapping(Object.keys(((state as { fieldState?: Record<string, unknown> }).fieldState ?? {})).filter((field) => field.startsWith("metadata.")));
  return new (await import("@tryformation/querylight-ts")).DocumentIndex(mapping).loadState(state as never);
}

function buildSearchQuery(
  query: string,
  filters: { sourceId?: string; tag?: string; metadata?: Array<{ key: string; value: string }> }
): BoolQuery {
  return new BoolQuery({
    should: [
      new MatchQuery({ field: "title", text: query, operation: OP.AND, boost: 6 }),
      new MatchQuery({ field: "text", text: query, operation: OP.AND, boost: 4 }),
      new MatchQuery({ field: "text", text: query, operation: OP.OR, boost: 2 })
    ],
    filter: [
      ...(filters.sourceId ? [new TermQuery({ field: "sourceId", text: filters.sourceId.toLowerCase() })] : []),
      ...(filters.tag ? [new TermQuery({ field: "tags", text: filters.tag.toLowerCase() })] : []),
      ...(filters.metadata ?? []).map(({ key, value }) => new TermQuery({ field: `metadata.${key}`, text: value.toLowerCase() }))
    ]
  });
}

function buildSnippet(text: string, query: string): string {
  const plain = text
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/!\[([^\]]*)\]\([^)]+\)/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/^\s*[-*+]\s+/gm, "")
    .replace(/\s+/g, " ")
    .trim();
  const lower = plain.toLowerCase();
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  const index = terms.map((term) => lower.indexOf(term)).find((value) => value != null && value >= 0) ?? 0;
  const start = Math.max(0, index - 40);
  const end = Math.min(plain.length, start + 200);
  return plain.slice(start, end).trim();
}

function normalizeDisplayTitle(title: string): string {
  return title
    .replace(/\s*\|\s*Querylight TS Demo\s*$/i, "")
    .replace(/\s+/g, " ")
    .trim();
}

function chooseResultTitle(chunk: ChunkRecord): string {
  const documentTitle = normalizeDisplayTitle(chunk.title);
  const headings = chunk.headingPath.map((heading) => normalizeDisplayTitle(heading)).filter(Boolean);
  const leafHeading = headings.at(-1);

  if (leafHeading && leafHeading.toLowerCase() !== documentTitle.toLowerCase()) {
    return leafHeading;
  }
  if (documentTitle) {
    return documentTitle;
  }
  return leafHeading ?? "Untitled";
}

export async function searchIndex(
  {
    workspacePath,
    query,
    topK,
    sourceId,
    tag,
    metadata,
    retrievalMode,
    showChunks = false
  }: {
    workspacePath: string;
    query: string;
    topK: number;
    sourceId?: string;
    tag?: string;
    metadata?: Array<{ key: string; value: string }>;
    retrievalMode?: RetrievalMode;
    showChunks?: boolean;
  }
): Promise<SearchResponseData> {
  const config = await loadConfig(workspacePath);
  const mode = retrievalMode ?? config.retrieval.defaultMode;
  const chunks = new Map((await readJsonl<ChunkRecord>(path.join(workspacePath, "chunks", "chunks.jsonl"))).map((chunk) => [chunk.id, chunk]));
  const filterIds = [...chunks.values()]
    .filter((chunk) => (!sourceId || chunk.sourceId === sourceId) && (!tag || (Array.isArray(chunk.metadata.tags) && chunk.metadata.tags.map(String).map((value) => value.toLowerCase()).includes(tag.toLowerCase()))) && (!(metadata?.length) || metadata.every(({ key, value }) => {
      const candidate = chunk.metadata[key];
      return Array.isArray(candidate) ? candidate.map(String).map((item) => item.toLowerCase()).includes(value.toLowerCase()) : String(candidate ?? "").toLowerCase() === value.toLowerCase();
    })))
    .map((chunk) => chunk.id);

  const lexicalHits = async () => {
    const index = await loadHydratedIndex(workspacePath);
    const all = await index.searchRequest({ query: buildSearchQuery(query, { sourceId, tag, metadata }), limit: Math.max(topK, 50) });
    return all.filter(([chunkId]) => filterIds.includes(chunkId)).slice(0, topK);
  };

  const denseHits = async () => {
    if (!await fileExists(denseVectorPath(workspacePath))) {
      throw new CliError("dense vector index is not built; run `qli models pull --dense` and `qli rebuild --dense`", "DENSE_INDEX_MISSING", ExitCode.QueryError);
    }
    return denseQuery({ workspacePath, config: config.retrieval.dense, query, topK }).then((hits) => hits.filter(([chunkId]) => filterIds.includes(chunkId)));
  };

  const sparseHits = async () => {
    if (!await fileExists(sparseVectorPath(workspacePath))) {
      throw new CliError("sparse vector index is not built; run `qli models pull --sparse` and `qli rebuild --sparse`", "SPARSE_INDEX_MISSING", ExitCode.QueryError);
    }
    return sparseQuery({ workspacePath, config: config.retrieval.sparse, query, topK }).then((hits) => hits.filter(([chunkId]) => filterIds.includes(chunkId)));
  };

  let hits: Array<[string, number]>;
  if (mode === "lexical") {
    hits = await lexicalHits();
  } else if (mode === "dense") {
    hits = await denseHits();
  } else if (mode === "sparse") {
    hits = await sparseHits();
  } else {
    const rankings: Array<Array<[string, number]>> = [await lexicalHits()];
    if (await fileExists(denseVectorPath(workspacePath))) {
      rankings.push(await denseQuery({ workspacePath, config: config.retrieval.dense, query, topK }).then((dense) => dense.filter(([chunkId]) => filterIds.includes(chunkId))));
    }
    if (await fileExists(sparseVectorPath(workspacePath))) {
      rankings.push(await sparseQuery({ workspacePath, config: config.retrieval.sparse, query, topK }).then((sparse) => sparse.filter(([chunkId]) => filterIds.includes(chunkId))));
    }
    hits = reciprocalRankFusion(rankings, { rankConstant: 20, weights: rankings.map((_, index) => index === 0 ? 3 : 1) }).slice(0, topK);
  }

  const results: SearchResult[] = hits.flatMap(([chunkId, score]) => {
    const chunk = chunks.get(chunkId);
    if (!chunk) {
      return [];
    }
    return [{
      chunkId,
      documentId: chunk.documentId,
      sourceId: chunk.sourceId,
      score,
      title: chooseResultTitle(chunk),
      uri: chunk.uri,
      headingPath: chunk.headingPath,
      snippet: buildSnippet(chunk.text, query),
      text: showChunks ? chunk.text : undefined,
      metadata: chunk.metadata
    }];
  });
  return { retrievalMode: mode, results };
}
