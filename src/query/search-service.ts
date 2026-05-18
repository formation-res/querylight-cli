import { readFile } from "node:fs/promises";
import { BoolQuery, MatchQuery, OP, TermQuery, reciprocalRankFusion, type DocumentIndex } from "@tryformation/querylight-ts";
import path from "node:path";
import { buildChunksForDocument } from "../chunk/chunker.js";
import { loadConfig } from "../core/config.js";
import { CliError, ExitCode } from "../core/errors.js";
import { fileExists } from "../core/files.js";
import { readJsonl } from "../core/jsonl.js";
import type { ChunkRecord, DocumentRecord, RetrievalMode, SearchResponseData, SearchResult, WorkspaceConfig } from "../types/models.js";
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

function stripSnippetMarkdown(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/!\[([^\]]*)\]\([^)]+\)/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/^\s*[-*+]\s+/gm, "");
}

function extractSnippetParagraphs(text: string): string[] {
  return stripSnippetMarkdown(text)
    .split(/\n\s*\n+/)
    .map((paragraph) => paragraph.replace(/\s+/g, " ").trim())
    .filter(Boolean);
}

function buildParagraphSnippet(paragraphs: string[], query: string, targetLength = 900): string {
  if (paragraphs.length === 0) {
    return "";
  }

  const lowerQueryTerms = query.toLowerCase().split(/\s+/).filter(Boolean);
  const matchIndex = paragraphs.findIndex((paragraph) => {
    const lower = paragraph.toLowerCase();
    return lowerQueryTerms.some((term) => lower.includes(term));
  });

  let start = matchIndex >= 0 ? matchIndex : 0;
  let end = start + 1;
  let totalLength = paragraphs[start]?.length ?? 0;

  while (totalLength < targetLength && (start > 0 || end < paragraphs.length)) {
    const previousLength = start > 0 ? (paragraphs[start - 1]?.length ?? 0) : -1;
    const nextLength = end < paragraphs.length ? (paragraphs[end]?.length ?? 0) : -1;

    if (nextLength >= previousLength && end < paragraphs.length) {
      totalLength += nextLength + 2;
      end += 1;
      continue;
    }

    if (start > 0) {
      totalLength += previousLength + 2;
      start -= 1;
      continue;
    }

    break;
  }

  return paragraphs.slice(start, end).join("\n\n").trim();
}

function buildSnippet(text: string, query: string): string {
  return buildParagraphSnippet(extractSnippetParagraphs(text), query);
}

type ChunkParagraph = {
  chunkIndex: number;
  text: string;
};

function buildDocumentParagraphs(chunks: ChunkRecord[]): ChunkParagraph[] {
  return chunks.flatMap((candidate, chunkIndex) =>
    extractSnippetParagraphs(candidate.text).map((text) => ({ chunkIndex, text }))
  );
}

function buildExpandedParagraphSnippet(
  paragraphs: ChunkParagraph[],
  chunkIndex: number,
  query: string,
  targetLength = 1200
): string {
  if (paragraphs.length === 0) {
    return "";
  }

  const lowerQueryTerms = query.toLowerCase().split(/\s+/).filter(Boolean);
  const currentParagraphIndexes = paragraphs
    .map((paragraph, index) => ({ ...paragraph, index }))
    .filter((paragraph) => paragraph.chunkIndex === chunkIndex)
    .map((paragraph) => paragraph.index);

  const anchorIndex = currentParagraphIndexes.find((index) => {
    const lower = paragraphs[index]?.text.toLowerCase() ?? "";
    return lowerQueryTerms.some((term) => lower.includes(term));
  }) ?? currentParagraphIndexes[0] ?? 0;

  let start = anchorIndex;
  let end = anchorIndex + 1;
  let totalLength = paragraphs[anchorIndex]?.text.length ?? 0;

  while (totalLength < targetLength && (start > 0 || end < paragraphs.length)) {
    const previousLength = start > 0 ? (paragraphs[start - 1]?.text.length ?? 0) : -1;
    const nextLength = end < paragraphs.length ? (paragraphs[end]?.text.length ?? 0) : -1;

    if (nextLength >= previousLength && end < paragraphs.length) {
      totalLength += nextLength + 2;
      end += 1;
      continue;
    }

    if (start > 0) {
      totalLength += previousLength + 2;
      start -= 1;
      continue;
    }

    break;
  }

  return paragraphs.slice(start, end).map((paragraph) => paragraph.text).join("\n\n").trim();
}

async function buildSnippetWithAdjacentChunks(
  chunk: ChunkRecord,
  query: string,
  {
    document,
    config,
    orderedChunkCache
  }: {
    document?: DocumentRecord;
    config: WorkspaceConfig;
    orderedChunkCache: Map<string, ChunkRecord[]>;
  }
): Promise<string> {
  if (!document) {
    return buildSnippet(chunk.text, query);
  }

  let orderedChunks = orderedChunkCache.get(document.id);
  if (!orderedChunks) {
    if (!await fileExists(document.normalizedPath)) {
      return buildSnippet(chunk.text, query);
    }
    const raw = await readFile(document.normalizedPath, "utf8");
    orderedChunks = buildChunksForDocument(document, raw, config);
    orderedChunkCache.set(document.id, orderedChunks);
  }

  const currentIndex = orderedChunks.findIndex((candidate) => candidate.id === chunk.id);
  if (currentIndex < 0) {
    return buildSnippet(chunk.text, query);
  }

  const current = orderedChunks[currentIndex]!;
  const paragraphs = buildDocumentParagraphs(orderedChunks);
  if (paragraphs.length === 0) {
    return buildSnippet(current.text, query);
  }
  return buildExpandedParagraphSnippet(paragraphs, currentIndex, query);
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

function normalizeComparisonText(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeUriPath(uri: string): string {
  try {
    const parsed = new URL(uri);
    const pathname = parsed.pathname.replace(/\/+$/, "") || "/";
    return pathname.toLowerCase();
  } catch {
    return uri.toLowerCase().replace(/\/+$/, "");
  }
}

function uriSpecificity(uri: string): number {
  const normalized = normalizeUriPath(uri);
  if (normalized === "/") {
    return 0;
  }
  return normalized.split("/").filter(Boolean).length;
}

function isMoreSpecificDuplicate(candidate: SearchResult, existing: SearchResult): boolean {
  if (candidate.sourceId !== existing.sourceId) {
    return false;
  }

  const candidateTitle = normalizeComparisonText(candidate.title);
  const existingTitle = normalizeComparisonText(existing.title);
  if (!candidateTitle || candidateTitle !== existingTitle) {
    return false;
  }

  const candidatePath = normalizeUriPath(candidate.uri);
  const existingPath = normalizeUriPath(existing.uri);
  if (candidatePath === existingPath) {
    return false;
  }

  const candidateIsChild = candidatePath.startsWith(existingPath === "/" ? "/" : `${existingPath}/`);
  const existingIsChild = existingPath.startsWith(candidatePath === "/" ? "/" : `${candidatePath}/`);
  if (!candidateIsChild && !existingIsChild) {
    return false;
  }

  return uriSpecificity(candidate.uri) > uriSpecificity(existing.uri);
}

function collapseAggregateDuplicates(results: SearchResult[], topK: number): SearchResult[] {
  const deduped: SearchResult[] = [];

  for (const result of results) {
    const duplicateIndex = deduped.findIndex((existing) =>
      isMoreSpecificDuplicate(result, existing) || isMoreSpecificDuplicate(existing, result)
    );

    if (duplicateIndex < 0) {
      deduped.push(result);
      continue;
    }

    if (isMoreSpecificDuplicate(result, deduped[duplicateIndex]!)) {
      deduped[duplicateIndex] = result;
    }
  }

  return deduped.slice(0, topK);
}

function rerankResultsByDocument(results: SearchResult[], topK: number): SearchResult[] {
  const byDocument = new Map<string, SearchResult[]>();
  for (const result of results) {
    const existing = byDocument.get(result.documentId);
    if (existing) {
      existing.push(result);
    } else {
      byDocument.set(result.documentId, [result]);
    }
  }

  const reranked: SearchResult[] = [...byDocument.values()]
    .flatMap((group) => {
      const sorted = [...group].sort((left, right) => right.score - left.score);
      const [best, ...rest] = sorted;
      if (!best) {
        return [];
      }
      const tailScore = rest.reduce((sum, result) => sum + result.score, 0);
      const aggregateScore = best.score + (tailScore * 0.35) + ((group.length - 1) * 0.2);
      return [{ ...best, score: aggregateScore }];
    })
    .sort((left, right) => right.score - left.score);

  return collapseAggregateDuplicates(reranked, topK);
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
  const candidateLimit = Math.max(topK * 5, 50);
  const chunks = new Map((await readJsonl<ChunkRecord>(path.join(workspacePath, "chunks", "chunks.jsonl"))).map((chunk) => [chunk.id, chunk]));
  const documents = new Map((await readJsonl<DocumentRecord>(path.join(workspacePath, "documents", "documents.jsonl"))).map((document) => [document.id, document]));
  const orderedChunkCache = new Map<string, ChunkRecord[]>();
  const filterIds = [...chunks.values()]
    .filter((chunk) => (!sourceId || chunk.sourceId === sourceId) && (!tag || (Array.isArray(chunk.metadata.tags) && chunk.metadata.tags.map(String).map((value) => value.toLowerCase()).includes(tag.toLowerCase()))) && (!(metadata?.length) || metadata.every(({ key, value }) => {
      const candidate = chunk.metadata[key];
      return Array.isArray(candidate) ? candidate.map(String).map((item) => item.toLowerCase()).includes(value.toLowerCase()) : String(candidate ?? "").toLowerCase() === value.toLowerCase();
    })))
    .map((chunk) => chunk.id);

  const lexicalHits = async () => {
    const index = await loadHydratedIndex(workspacePath);
    const all = await index.searchRequest({ query: buildSearchQuery(query, { sourceId, tag, metadata }), limit: candidateLimit });
    return all.filter(([chunkId]) => filterIds.includes(chunkId)).slice(0, candidateLimit);
  };

  const denseHits = async () => {
    if (!await fileExists(denseVectorPath(workspacePath))) {
      throw new CliError("dense vector index is not built; run `qli models pull --dense` and `qli rebuild`", "DENSE_INDEX_MISSING", ExitCode.QueryError);
    }
    return denseQuery({ workspacePath, config: config.retrieval.dense, query, topK: candidateLimit }).then((hits) => hits.filter(([chunkId]) => filterIds.includes(chunkId)).slice(0, candidateLimit));
  };

  const sparseHits = async () => {
    if (!await fileExists(sparseVectorPath(workspacePath))) {
      throw new CliError("sparse vector index is not built; run `qli models pull --sparse` and `qli rebuild`", "SPARSE_INDEX_MISSING", ExitCode.QueryError);
    }
    return sparseQuery({ workspacePath, config: config.retrieval.sparse, query, topK: candidateLimit }).then((hits) => hits.filter(([chunkId]) => filterIds.includes(chunkId)).slice(0, candidateLimit));
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
      rankings.push(await denseQuery({ workspacePath, config: config.retrieval.dense, query, topK: candidateLimit }).then((dense) => dense.filter(([chunkId]) => filterIds.includes(chunkId)).slice(0, candidateLimit)));
    }
    if (await fileExists(sparseVectorPath(workspacePath))) {
      rankings.push(await sparseQuery({ workspacePath, config: config.retrieval.sparse, query, topK: candidateLimit }).then((sparse) => sparse.filter(([chunkId]) => filterIds.includes(chunkId)).slice(0, candidateLimit)));
    }
    hits = reciprocalRankFusion(rankings, { rankConstant: 20, weights: rankings.map((_, index) => index === 0 ? 3 : 1) }).slice(0, candidateLimit);
  }

  const rawResults: Array<SearchResult | null> = await Promise.all(hits.map(async ([chunkId, score]) => {
    const chunk = chunks.get(chunkId);
    if (!chunk) {
      return null;
    }
    return {
      chunkId,
      documentId: chunk.documentId,
      sourceId: chunk.sourceId,
      score,
      title: chooseResultTitle(chunk),
      uri: chunk.uri,
      headingPath: chunk.headingPath,
      snippet: await buildSnippetWithAdjacentChunks(chunk, query, {
        document: documents.get(chunk.documentId),
        config,
        orderedChunkCache
      }),
      text: showChunks ? chunk.text : undefined,
      metadata: chunk.metadata
    } satisfies SearchResult;
  }));
  const results = rawResults.filter((result): result is SearchResult => result != null);
  return { retrievalMode: mode, results: rerankResultsByDocument(results, topK) };
}
