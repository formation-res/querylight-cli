import type { ChunkRecord } from "../types/models.js";

export function createDenseChunkText(chunk: ChunkRecord): string {
  return [chunk.title, ...chunk.headingPath, chunk.text].filter(Boolean).join("\n\n");
}

export function createSparseChunkText(chunk: ChunkRecord): string {
  return [chunk.title, ...chunk.headingPath, chunk.text].filter(Boolean).join("\n\n");
}
