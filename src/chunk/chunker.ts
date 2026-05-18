import { readFile } from "node:fs/promises";
import matter from "gray-matter";
import path from "node:path";
import { loadConfig } from "../core/config.js";
import { sha256 } from "../core/hashing.js";
import { stableId } from "../core/ids.js";
import { readJsonl } from "../core/jsonl.js";
import type { ChunkRecord, DocumentRecord } from "../types/models.js";
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
    const end = Math.min(text.length, start + maxChars);
    let slice = text.slice(start, end);
    const paragraphBreak = slice.lastIndexOf("\n\n");
    if (paragraphBreak > maxChars / 2 && end < text.length) {
      slice = slice.slice(0, paragraphBreak);
    }
    chunks.push(slice.trim());
    start += Math.max(1, slice.length - overlapChars);
  }
  return chunks.filter((chunk) => chunk.length > 0);
}

function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

export async function chunkDocuments(
  {
    workspacePath,
    sourceId,
    documentId
  }: {
    workspacePath: string;
    sourceId?: string;
    documentId?: string;
  }
): Promise<{ chunksWritten: number }> {
  const config = await loadConfig(workspacePath);
  const documents = await readJsonl<DocumentRecord>(path.join(workspacePath, "documents", "documents.jsonl"));
  const filtered = documents.filter((document) => (!sourceId || document.sourceId === sourceId) && (!documentId || document.id === documentId));
  const targetedDocumentIds = new Set(filtered.map((document) => document.id));
  const existingChunks = await loadChunks(workspacePath);
  const prior = new Map(existingChunks.map((chunk) => [chunk.id, chunk]));
  const nextChunks = new Map<string, ChunkRecord>(
    existingChunks
      .filter((chunk) => !targetedDocumentIds.has(chunk.documentId))
      .map((chunk) => [chunk.id, chunk])
  );

  for (const document of filtered) {
    const raw = await readFile(document.normalizedPath, "utf8");
    const parsed = matter(raw);
    const sections = splitSections(parsed.content);
    const usefulSections = sections.length > 0 ? sections : [{ headingPath: [document.title], text: parsed.content }];
    for (const section of usefulSections) {
      const pieces = splitLongSection(section.text, config.index.chunking.maxChars, config.index.chunking.overlapChars);
      for (const piece of pieces) {
        if (piece.trim().length < Math.min(40, config.index.chunking.minChars) && pieces.length === 1) {
          continue;
        }
        const id = stableId("chunk", document.id, section.headingPath.join(" > "), piece.trim());
        const priorChunk = prior.get(id);
        const text = piece.trim();
        nextChunks.set(id, {
          id,
          documentId: document.id,
          sourceId: document.sourceId,
          title: document.title,
          uri: document.uri,
          headingPath: section.headingPath,
          text,
          tokenEstimate: estimateTokens(text),
          contentHash: sha256(text),
          metadata: document.metadata,
          firstSeenAt: priorChunk?.firstSeenAt ?? document.firstSeenAt,
          lastSeenAt: new Date().toISOString(),
          lastChangedAt: priorChunk?.contentHash === sha256(text) ? priorChunk.lastChangedAt : document.lastChangedAt
        });
      }
    }
  }

  await saveChunks(workspacePath, [...nextChunks.values()]);
  return { chunksWritten: nextChunks.size };
}
