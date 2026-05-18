import { BoolQuery, MatchQuery, OP, TermQuery, type DocumentIndex } from "@tryformation/querylight-ts";
import path from "node:path";
import { readJsonl } from "../core/jsonl.js";
import type { ChunkRecord, SearchResponseData, SearchResult } from "../types/models.js";
import { readLatestIndexState } from "../index/index-store.js";
import { createIndexMapping } from "../index/querylight-indexer.js";

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
  const lower = text.toLowerCase();
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  const index = terms.map((term) => lower.indexOf(term)).find((value) => value != null && value >= 0) ?? 0;
  const start = Math.max(0, index - 40);
  const end = Math.min(text.length, start + 200);
  return text.slice(start, end).replace(/\s+/g, " ").trim();
}

export async function searchIndex(
  {
    workspacePath,
    query,
    topK,
    sourceId,
    tag,
    metadata,
    showChunks = false
  }: {
    workspacePath: string;
    query: string;
    topK: number;
    sourceId?: string;
    tag?: string;
    metadata?: Array<{ key: string; value: string }>;
    showChunks?: boolean;
  }
): Promise<SearchResponseData> {
  const index = await loadHydratedIndex(workspacePath);
  const hits = await index.searchRequest({ query: buildSearchQuery(query, { sourceId, tag, metadata }), limit: topK });
  const chunks = new Map((await readJsonl<ChunkRecord>(path.join(workspacePath, "chunks", "chunks.jsonl"))).map((chunk) => [chunk.id, chunk]));
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
      title: chunk.title,
      uri: chunk.uri,
      headingPath: chunk.headingPath,
      snippet: buildSnippet(chunk.text, query),
      text: showChunks ? chunk.text : undefined,
      metadata: chunk.metadata
    }];
  });
  return { results };
}
