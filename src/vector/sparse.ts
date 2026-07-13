import { SparseVectorFieldIndex, type SparseVector, type SparseVectorFieldIndexState } from "@tryformation/querylight-ts";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { hashJson } from "../core/gzip-json.js";
import { readJsonl } from "../core/jsonl.js";
import { reportProgress, reportProgressDetail, type ProgressHandler } from "../core/progress.js";
import type { ChunkRecord, SparseVectorMetadata, SparseVectorPayload, SparseVectorRecord, WorkspaceConfig } from "../types/models.js";
import { ensureUvAvailable, getDenseTransformersRuntime, resolveCacheDir, runSparsePython } from "./runtime.js";
import { readSparsePayload, writeSparsePayload } from "./store.js";
import { createSparseChunkText } from "./text.js";

let sparseQueryEncoderFactory: ((cacheDir: string, modelId: string, queryTokenWeights: number[]) => Promise<(text: string) => Promise<SparseVector>>) | null = null;
let sparseDocumentBuilderFactory: ((workspacePath: string, config: WorkspaceConfig["retrieval"]["sparse"], chunks: ChunkRecord[]) => Promise<{
  queryTokenWeights: number[];
  vocabularySize: number;
  chunks: SparseVectorRecord[];
  skippedChunks?: Array<{ chunkId: string; error: string }>;
}>) | null = null;

export function setSparseQueryEncoderFactoryForTests(
  factory: ((cacheDir: string, modelId: string, queryTokenWeights: number[]) => Promise<(text: string) => Promise<SparseVector>>) | null
): void {
  sparseQueryEncoderFactory = factory;
}

export function setSparseDocumentBuilderFactoryForTests(
  factory: ((workspacePath: string, config: WorkspaceConfig["retrieval"]["sparse"], chunks: ChunkRecord[]) => Promise<{
    queryTokenWeights: number[];
    vocabularySize: number;
    chunks: SparseVectorRecord[];
    skippedChunks?: Array<{ chunkId: string; error: string }>;
  }>) | null
): void {
  sparseDocumentBuilderFactory = factory;
}

export function normalizeSparseDocumentText(value: unknown): string {
  if (typeof value === "string") {
    return value.replaceAll("\u0000", " ");
  }
  if (value == null) {
    return "";
  }
  if (typeof Buffer !== "undefined" && Buffer.isBuffer(value)) {
    return value.toString("utf8").replaceAll("\u0000", " ");
  }
  if (value instanceof Uint8Array) {
    return new TextDecoder().decode(value).replaceAll("\u0000", " ");
  }
  if (typeof value === "object") {
    try {
      return JSON.stringify(value).replaceAll("\u0000", " ");
    } catch {
      return String(value).replaceAll("\u0000", " ");
    }
  }
  return String(value).replaceAll("\u0000", " ");
}

function buildSparseQueryVector(tokenIds: number[], tokenWeights: number[]): SparseVector {
  const sparseVector: SparseVector = {};
  for (const tokenId of new Set(tokenIds)) {
    const weight = tokenWeights[tokenId] ?? 0;
    if (weight > 0) {
      sparseVector[String(tokenId)] = weight;
    }
  }
  return sparseVector;
}

function normalizeTokenIds(value: unknown): number[] {
  if (value && typeof value === "object" && "data" in value) {
    const data = (value as { data?: unknown }).data;
    if (Array.isArray(data)) {
      return data.map(Number).filter(Number.isFinite);
    }
    if (ArrayBuffer.isView(data)) {
      return Array.from(data as unknown as Iterable<number>, Number).filter(Number.isFinite);
    }
  }
  if (!Array.isArray(value)) {
    return [];
  }
  if (value.length === 0) {
    return [];
  }
  if (Array.isArray(value[0])) {
    return (value[0] as unknown[]).map(Number).filter(Number.isFinite);
  }
  return value.map(Number).filter(Number.isFinite);
}

async function createSparseQueryEncoder(cacheDir: string, modelId: string, queryTokenWeights: number[]): Promise<(text: string) => Promise<SparseVector>> {
  if (sparseQueryEncoderFactory) {
    return sparseQueryEncoderFactory(cacheDir, modelId, queryTokenWeights);
  }
  const runtime = await getDenseTransformersRuntime(cacheDir);
  const { AutoTokenizer } = await import("@huggingface/transformers");
  runtime.env.cacheDir = cacheDir;
  const tokenizer = await AutoTokenizer.from_pretrained(modelId);
  return async (text: string): Promise<SparseVector> => {
    const features = await tokenizer([text], {
      truncation: true,
      return_token_type_ids: false
    });
    return buildSparseQueryVector(normalizeTokenIds(features.input_ids), queryTokenWeights);
  };
}

export async function pullSparseModel(workspacePath: string, config: WorkspaceConfig["retrieval"]["sparse"]): Promise<void> {
  await ensureUvAvailable();
  const cacheDir = resolveCacheDir(workspacePath, config.cacheDir);
  await mkdir(cacheDir, { recursive: true });
  await runSparsePython({
    workspacePath,
    config,
    importMetaUrl: import.meta.url,
    payload: {
      action: "download_only",
      model_id: config.modelId
    }
  });
}

async function buildSparseDocuments(
  workspacePath: string,
  config: WorkspaceConfig["retrieval"]["sparse"],
  chunks: ChunkRecord[]
): Promise<{
  queryTokenWeights: number[];
  vocabularySize: number;
  chunks: SparseVectorRecord[];
  skippedChunks: Array<{ chunkId: string; error: string }>;
}> {
  if (sparseDocumentBuilderFactory) {
    const built = await sparseDocumentBuilderFactory(workspacePath, config, chunks);
    return {
      ...built,
      skippedChunks: built.skippedChunks ?? []
    };
  }
  await ensureUvAvailable();
  const output = JSON.parse(await runSparsePython({
    workspacePath,
    config,
    importMetaUrl: import.meta.url,
    payload: {
      action: "encode_documents",
      model_id: config.modelId,
      top_tokens: config.documentTopTokens,
      batch_size: config.documentBatchSize,
      documents: chunks.map((chunk) => ({
        chunkId: chunk.id,
        text: normalizeSparseDocumentText(createSparseChunkText(chunk))
      }))
    }
  })) as {
    query_token_weights: number[];
    vocabularySize: number;
    documents: Array<{ chunkId: string; vector: Record<string, number> }>;
    skipped_documents?: Array<{ chunkId: string; error: string }>;
  };
  const byId = new Map(output.documents.map((document) => [document.chunkId, document.vector]));
  return {
    queryTokenWeights: output.query_token_weights,
    vocabularySize: output.vocabularySize,
    skippedChunks: output.skipped_documents ?? [],
    chunks: chunks.map((chunk) => ({
      chunkId: chunk.id,
      documentId: chunk.documentId,
      sourceId: chunk.sourceId,
      title: chunk.title,
      uri: chunk.uri,
      headingPath: chunk.headingPath,
      text: chunk.text,
      vector: byId.get(chunk.id) ?? {}
    }))
  };
}

export async function buildSparseVectors(
  {
    workspacePath,
    config,
    progress
  }: {
    workspacePath: string;
    config: WorkspaceConfig["retrieval"]["sparse"];
    progress?: ProgressHandler;
  }
): Promise<SparseVectorPayload> {
  const chunks = await readJsonl<ChunkRecord>(path.join(workspacePath, "chunks", "chunks.jsonl"));
  reportProgress(progress, `Encoding ${chunks.length} chunk${chunks.length === 1 ? "" : "s"} for sparse retrieval`);
  const built = await buildSparseDocuments(workspacePath, config, chunks);
  if (built.skippedChunks.length > 0) {
    reportProgress(
      progress,
      `Skipped sparse vectors for ${built.skippedChunks.length} chunk${built.skippedChunks.length === 1 ? "" : "s"} due to encoding errors`
    );
    for (const skipped of built.skippedChunks) {
      reportProgressDetail(progress, `Skipped sparse chunk ${skipped.chunkId}: ${skipped.error}`);
    }
  }
  reportProgress(progress, "Building sparse vector index");
  const index = new SparseVectorFieldIndex();
  for (const record of built.chunks) {
    index.insert(record.chunkId, [record.vector]);
  }
  const metadata: SparseVectorMetadata = {
    createdAt: new Date().toISOString(),
    modelId: config.modelId,
    vocabularySize: built.vocabularySize,
    documentTopTokens: config.documentTopTokens,
    documentBatchSize: config.documentBatchSize,
    queryEncoding: config.queryEncoding,
    documentEncoding: config.documentEncoding,
    chunkCount: built.chunks.length,
    indexHash: await hashJson(index.indexState)
  };
  const payload: SparseVectorPayload = {
    metadata,
    indexState: index.indexState as unknown as object,
    chunks: built.chunks,
    queryTokenWeights: built.queryTokenWeights
  };
  await writeSparsePayload(workspacePath, payload);
  reportProgress(progress, `Sparse vectors written for ${built.chunks.length} chunk${built.chunks.length === 1 ? "" : "s"}`);
  return payload;
}

export async function sparseQuery(
  {
    workspacePath,
    config,
    query,
    topK
  }: {
    workspacePath: string;
    config: WorkspaceConfig["retrieval"]["sparse"];
    query: string;
    topK: number;
  }
): Promise<Array<[string, number]>> {
  const payload = await readSparsePayload(workspacePath);
  const cacheDir = resolveCacheDir(workspacePath, config.cacheDir);
  const encode = await createSparseQueryEncoder(cacheDir, config.modelId, payload.queryTokenWeights);
  const vector = await encode(query);
  const index = new SparseVectorFieldIndex().loadState(payload.indexState as SparseVectorFieldIndexState);
  return index.query(vector, topK);
}

export async function inferSparseVector(
  {
    workspacePath,
    config,
    text
  }: {
    workspacePath: string;
    config: WorkspaceConfig["retrieval"]["sparse"];
    text: string;
  }
): Promise<SparseVector> {
  const payload = await readSparsePayload(workspacePath);
  const cacheDir = resolveCacheDir(workspacePath, config.cacheDir);
  const encode = await createSparseQueryEncoder(cacheDir, config.modelId, payload.queryTokenWeights);
  return encode(text);
}
