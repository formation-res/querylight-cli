import path from "node:path";
import type { ChunkRecord } from "../types/models.js";
import { readJsonl, writeJsonl } from "../core/jsonl.js";

export function chunksFile(workspacePath: string): string {
  return path.join(workspacePath, "chunks", "chunks.jsonl");
}

export async function loadChunks(workspacePath: string): Promise<ChunkRecord[]> {
  return readJsonl<ChunkRecord>(chunksFile(workspacePath));
}

export async function saveChunks(workspacePath: string, chunks: ChunkRecord[]): Promise<void> {
  await writeJsonl(chunksFile(workspacePath), chunks.sort((a, b) => a.id.localeCompare(b.id)));
}
