import type { ContextResponseData, ContextSource } from "../types/models.js";
import { searchIndex, searchResultsFromResponse } from "./search-service.js";

export async function createContext(
  {
    workspacePath,
    query,
    topK,
    maxChars,
    retrievalMode
  }: {
    workspacePath: string;
    query: string;
    topK: number;
    maxChars: number;
    retrievalMode?: import("../types/models.js").RetrievalMode;
  }
): Promise<ContextResponseData> {
  const search = await searchIndex({ workspacePath, query, topK, showChunks: true, retrievalMode });
  const results = searchResultsFromResponse(search, true);
  const sources: ContextSource[] = [];
  let total = 0;
  for (const result of results) {
    const text = result.text ?? "";
    if (total + text.length > maxChars && sources.length > 0) {
      break;
    }
    total += text.length;
    sources.push({
      chunkId: result.chunkId,
      documentId: result.documentId,
      sourceId: result.sourceId,
      title: result.title,
      uri: result.uri,
      text,
      metadata: result.metadata
    });
  }
  const markdown = [
    "# Context",
    "",
    ...sources.flatMap((source, index) => [
      `## Source ${index + 1}`,
      `Title: ${source.title}`,
      `URL: ${source.uri}`,
      `Chunk ID: ${source.chunkId}`,
      "",
      source.text,
      ""
    ].filter((line) => line !== ""))
  ].join("\n");
  return { markdown, sources, retrievalMode: search.retrievalMode };
}
