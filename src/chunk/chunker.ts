import { readFile } from "node:fs/promises";
import matter from "gray-matter";
import path from "node:path";
import { loadConfig } from "../core/config.js";
import { sha256 } from "../core/hashing.js";
import { stableId } from "../core/ids.js";
import { readJsonl } from "../core/jsonl.js";
import { reportProgress, reportProgressDetail, type ProgressHandler } from "../core/progress.js";
import type { ChunkRecord, DocumentRecord, WorkspaceConfig } from "../types/models.js";
import { loadChunks, saveChunks } from "./chunk-store.js";

type Section = {
  headingPath: string[];
  text: string;
};

function splitSections(markdown: string): Section[] {
  const lines = markdown.split("\n");
  const sections: Section[] = [];
  let headingPath: string[] = [];
  let current: string[] = [];

  const flush = (): void => {
    const text = current.join("\n").trim();
    if (text.length > 0) {
      sections.push({ headingPath: [...headingPath], text });
    }
    current = [];
  };

  for (const line of lines) {
    const match = /^(#{1,6})\s+(.+)$/.exec(line);
    if (match?.[1] && match[2]) {
      flush();
      const level = match[1].length;
      headingPath = [...headingPath.slice(0, level - 1), match[2].trim()];
      current.push(line);
      continue;
    }
    current.push(line);
  }
  flush();
  return sections;
}

function splitLongSection(text: string, maxChars: number, overlapChars: number): string[] {
  if (text.length <= maxChars) {
    return [text];
  }
  const chunks: string[] = [];
  let start = 0;
  while (start < text.length) {
    const hardEnd = Math.min(text.length, start + maxChars);
    let sliceEnd = hardEnd;
    const window = text.slice(start, hardEnd);
    const paragraphBreak = window.lastIndexOf("\n\n");
    if (paragraphBreak > maxChars / 2 && hardEnd < text.length) {
      const candidateEnd = start + paragraphBreak;
      // Ignore paragraph breaks that would create a chunk smaller than the overlap,
      // otherwise we can degrade into 1-char forward progress and explode chunk counts.
      if (candidateEnd - start > overlapChars) {
        sliceEnd = candidateEnd;
      }
    }
    const slice = text.slice(start, sliceEnd).trim();
    if (slice.length === 0) {
      start = hardEnd;
      continue;
    }
    chunks.push(slice);
    const nextStart = sliceEnd - overlapChars;
    start = nextStart > start ? nextStart : hardEnd;
  }
  return chunks.filter((chunk) => chunk.length > 0);
}

function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

export function buildChunksForDocument(
  document: DocumentRecord,
  markdown: string,
  config: WorkspaceConfig,
  prior = new Map<string, ChunkRecord>(),
  seenAt = new Date().toISOString()
): ChunkRecord[] {
  const parsed = matter(markdown);
  const sections = splitSections(parsed.content);
  const usefulSections = sections.length > 0 ? sections : [{ headingPath: [document.title], text: parsed.content }];
  const chunks: ChunkRecord[] = [];

  for (const section of usefulSections) {
    const pieces = splitLongSection(section.text, config.index.chunking.maxChars, config.index.chunking.overlapChars);
    for (const piece of pieces) {
      if (piece.trim().length < Math.min(40, config.index.chunking.minChars) && pieces.length === 1) {
        continue;
      }
      const text = piece.trim();
      const id = stableId("chunk", document.id, section.headingPath.join(" > "), text);
      const priorChunk = prior.get(id);
      const contentHash = sha256(text);
      chunks.push({
        id,
        documentId: document.id,
        sourceId: document.sourceId,
        title: document.title,
        uri: document.uri,
        headingPath: section.headingPath,
        text,
        tokenEstimate: estimateTokens(text),
        contentHash,
        metadata: document.metadata,
        firstSeenAt: priorChunk?.firstSeenAt ?? document.firstSeenAt,
        lastSeenAt: seenAt,
        lastChangedAt: priorChunk?.contentHash === contentHash ? priorChunk.lastChangedAt : document.lastChangedAt
      });
    }
  }

  return chunks;
}

export async function chunkDocuments(
  {
    workspacePath,
    sourceId,
    documentId,
    progress
  }: {
    workspacePath: string;
    sourceId?: string;
    documentId?: string;
    progress?: ProgressHandler;
  }
): Promise<{ chunksWritten: number }> {
  const config = await loadConfig(workspacePath);
  const documents = await readJsonl<DocumentRecord>(path.join(workspacePath, "documents", "documents.jsonl"));
  const filtered = documents.filter((document) => (!sourceId || document.sourceId === sourceId) && (!documentId || document.id === documentId));
  reportProgress(progress, `Chunking ${filtered.length} document${filtered.length === 1 ? "" : "s"}`);
  const targetedDocumentIds = new Set(filtered.map((document) => document.id));
  const existingChunks = await loadChunks(workspacePath);
  const prior = new Map(existingChunks.map((chunk) => [chunk.id, chunk]));
  const nextChunks = new Map<string, ChunkRecord>(
    existingChunks
      .filter((chunk) => !targetedDocumentIds.has(chunk.documentId))
      .map((chunk) => [chunk.id, chunk])
  );

  for (const document of filtered) {
    reportProgressDetail(progress, `Chunking ${document.id} (${document.title})`);
    const raw = await readFile(document.normalizedPath, "utf8");
    for (const chunk of buildChunksForDocument(document, raw, config, prior)) {
      nextChunks.set(chunk.id, chunk);
    }
  }

  await saveChunks(workspacePath, [...nextChunks.values()]);
  reportProgress(progress, `Chunking complete: ${nextChunks.size} chunk${nextChunks.size === 1 ? "" : "s"} written`);
  return { chunksWritten: nextChunks.size };
}
