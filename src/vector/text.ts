import type { ChunkRecord } from "../types/models.js";

const LOW_SIGNAL_HEADINGS = new Set([
  "choose this instead of",
  "how xyz runs it",
  "naechste schritte",
  "next steps",
  "overview",
  "passend wenn",
  "problem",
  "right fit",
  "waehlen sie das stattdessen",
  "was sie bekommen",
  "what you get",
  "wie xyz es umsetzt",
  "uberblick",
  "überblick"
]);

function normalizeHeading(value: string): string {
  return value.trim().toLowerCase();
}

function isLowSignalHeading(value: string): boolean {
  return LOW_SIGNAL_HEADINGS.has(normalizeHeading(value));
}

function stripLeadingHeading(text: string, heading: string): string {
  const lines = text.split("\n");
  const firstContentIndex = lines.findIndex((line) => line.trim().length > 0);
  if (firstContentIndex < 0) {
    return text;
  }
  const match = /^(#{1,6})\s+(.+)$/.exec(lines[firstContentIndex] ?? "");
  if (!match?.[2] || normalizeHeading(match[2]) !== normalizeHeading(heading)) {
    return text;
  }
  const next = [...lines.slice(0, firstContentIndex), ...lines.slice(firstContentIndex + 1)].join("\n").trim();
  return next;
}

function createVectorText(chunk: ChunkRecord): string {
  const meaningfulHeadings = chunk.headingPath.filter((heading) => !isLowSignalHeading(heading) && normalizeHeading(heading) !== normalizeHeading(chunk.title));
  const textHeading = [...chunk.headingPath].reverse().find((heading) => isLowSignalHeading(heading) || normalizeHeading(heading) === normalizeHeading(chunk.title));
  const body = textHeading ? stripLeadingHeading(chunk.text, textHeading) : chunk.text.trim();
  return [chunk.title, ...meaningfulHeadings, body].filter(Boolean).join("\n\n");
}

export function createDenseChunkText(chunk: ChunkRecord): string {
  return createVectorText(chunk);
}

export function createSparseChunkText(chunk: ChunkRecord): string {
  return createVectorText(chunk);
}
