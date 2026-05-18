import { VectorFieldIndex, createSeededRandom, type VectorFieldIndexState } from "@tryformation/querylight-ts";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { sha256 } from "../core/hashing.js";
import { readJsonl } from "../core/jsonl.js";
import type { ChunkRecord, DenseVectorMetadata, DenseVectorPayload, DenseVectorRecord, RetrievalMode, WorkspaceConfig } from "../types/models.js";
import { getDenseTransformersRuntime, resolveCacheDir } from "./runtime.js";
import { writeDensePayload, readDensePayload } from "./store.js";
import { createDenseChunkText } from "./text.js";

let denseEmbedderFactory: ((cacheDir: string, modelId: string) => Promise<(text: string) => Promise<number[]>>) | null = null;

export function setDenseEmbedderFactoryForTests(
  factory: ((cacheDir: string, modelId: string) => Promise<(text: string) => Promise<number[]>>) | null
): void {
  denseEmbedderFactory = factory;
}

async function createEmbedder(cacheDir: string, modelId: string): Promise<(text: string) => Promise<number[]>> {
  if (denseEmbedderFactory) {
    return denseEmbedderFactory(cacheDir, modelId);
  }
  const runtime = await getDenseTransformersRuntime(cacheDir);
  const extractor = await runtime.pipeline("feature-extraction", modelId);
  return async (text: string): Promise<number[]> => {
    const output = await extractor(text, { pooling: "mean", normalize: true });
    return output.tolist()[0] as number[];
  };
}

export async function pullDenseModel(workspacePath: string, config: WorkspaceConfig["retrieval"]["dense"]): Promise<void> {
  const cacheDir = resolveCacheDir(workspacePath, config.cacheDir);
  await mkdir(cacheDir, { recursive: true });
  const embed = await createEmbedder(cacheDir, config.modelId);
  await embed("warm dense model cache");
}

export async function buildDenseVectors(
  {
    workspacePath,
    config
  }: {
    workspacePath: string;
    config: WorkspaceConfig["retrieval"]["dense"];
  }
): Promise<DenseVectorPayload> {
  const chunks = await readJsonl<ChunkRecord>(path.join(workspacePath, "chunks", "chunks.jsonl"));
  const cacheDir = resolveCacheDir(workspacePath, config.cacheDir);
  await mkdir(cacheDir, { recursive: true });
  const embed = await createEmbedder(cacheDir, config.modelId);
  const records: DenseVectorRecord[] = [];
  let dimensions = 0;

  for (const chunk of chunks) {
    const embedding = await embed(createDenseChunkText(chunk));
    dimensions ||= embedding.length;
    records.push({
      chunkId: chunk.id,
      documentId: chunk.documentId,
      sourceId: chunk.sourceId,
      title: chunk.title,
      uri: chunk.uri,
      headingPath: chunk.headingPath,
      text: chunk.text,
      embedding
    });
  }

  const index = new VectorFieldIndex({
    numHashTables: config.indexHashTables,
    dimensions,
    random: createSeededRandom(config.indexRandomSeed)
  });
  for (const record of records) {
    index.insert(record.chunkId, [record.embedding]);
  }
  const metadata: DenseVectorMetadata = {
    createdAt: new Date().toISOString(),
    modelId: config.modelId,
    dimensions,
    hashTables: config.indexHashTables,
    randomSeed: config.indexRandomSeed,
    chunkCount: records.length,
    indexHash: sha256(JSON.stringify(index.indexState))
  };
  const payload: DenseVectorPayload = {
    metadata,
    indexState: index.indexState as unknown as object,
    chunks: records
  };
  await writeDensePayload(workspacePath, payload);
  return payload;
}

export async function denseQuery(
  {
    workspacePath,
    config,
    query,
    topK
  }: {
    workspacePath: string;
    config: WorkspaceConfig["retrieval"]["dense"];
    query: string;
    topK: number;
  }
): Promise<Array<[string, number]>> {
  const payload = await readDensePayload(workspacePath);
  const cacheDir = resolveCacheDir(workspacePath, config.cacheDir);
  const embed = await createEmbedder(cacheDir, config.modelId);
  const vector = await embed(query);
  const index = new VectorFieldIndex({
    numHashTables: payload.metadata.hashTables,
    dimensions: payload.metadata.dimensions,
    random: createSeededRandom(payload.metadata.randomSeed)
  }).loadState(payload.indexState as VectorFieldIndexState) as VectorFieldIndex;
  return index.query(vector, topK);
}
