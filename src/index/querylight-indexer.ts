import { Analyzer, DocumentIndex, KeywordTokenizer, LowerCaseTextFilter, RankingAlgorithm, TextFieldIndex } from "@tryformation/querylight-ts";
import path from "node:path";
import { sha256 } from "../core/hashing.js";
import { readJsonl } from "../core/jsonl.js";
import type { ChunkRecord, DocumentRecord, IndexMetadata, Source } from "../types/models.js";
import { writeIndexArtifacts } from "./index-store.js";

function keywordFieldIndex(): TextFieldIndex {
  const analyzer = new Analyzer([new LowerCaseTextFilter()], new KeywordTokenizer());
  return new TextFieldIndex(analyzer, analyzer, RankingAlgorithm.BM25);
}

export function createIndexMapping(extraFields: string[] = []): Record<string, TextFieldIndex> {
  const lexical = new TextFieldIndex(undefined, undefined, RankingAlgorithm.BM25);
  const mapping: Record<string, TextFieldIndex> = {
    text: lexical,
    title: new TextFieldIndex(undefined, undefined, RankingAlgorithm.BM25),
    uri: keywordFieldIndex(),
    sourceId: keywordFieldIndex(),
    tags: keywordFieldIndex(),
    sourceType: keywordFieldIndex()
  };
  for (const field of extraFields) {
    mapping[field] = keywordFieldIndex();
  }
  return mapping;
}

function flattenMetadata(metadata: Record<string, unknown>): Record<string, string[]> {
  const flattened: Record<string, string[]> = {};
  for (const [key, value] of Object.entries(metadata)) {
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
    workspacePath
  }: {
    workspacePath: string;
  }
): Promise<{ metadata: IndexMetadata; indexPath: string }> {
  const chunks = await readJsonl<ChunkRecord>(path.join(workspacePath, "chunks", "chunks.jsonl"));
  const documents = await readJsonl<DocumentRecord>(path.join(workspacePath, "documents", "documents.jsonl"));
  const sources = await readJsonl<Source>(path.join(workspacePath, "sources", "sources.jsonl"));
  const metadataFields = [...new Set(chunks.flatMap((chunk) => Object.keys(chunk.metadata).map((key) => `metadata.${key}`)))];
  const index = new DocumentIndex(createIndexMapping(metadataFields));

  for (const chunk of chunks) {
    index.index({
      id: chunk.id,
      fields: {
        text: [chunk.text],
        title: [chunk.title],
        uri: [chunk.uri.toLowerCase()],
        sourceId: [chunk.sourceId.toLowerCase()],
        tags: Array.isArray(chunk.metadata.tags) ? chunk.metadata.tags.map((tag) => String(tag).toLowerCase()) : [],
        sourceType: [String(chunk.metadata.sourceType ?? "").toLowerCase()],
        ...flattenMetadata(chunk.metadata)
      }
    });
  }

  const createdAt = new Date().toISOString();
  const metadata: IndexMetadata = {
    id: `index_${createdAt.replace(/[:.]/g, "-")}`,
    createdAt,
    querylightVersion: "0.10.0",
    kbVersion: "0.1.0",
    documentCount: documents.length,
    chunkCount: chunks.length,
    sourceCount: sources.length,
    fields: Object.keys(index.mapping),
    indexHash: sha256(JSON.stringify(index.indexState))
  };
  const artifacts = await writeIndexArtifacts({ workspacePath, indexState: index.indexState, metadata });
  return { metadata, indexPath: artifacts.indexPath };
}
