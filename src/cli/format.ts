import Table from "cli-table3";
import colors from "picocolors";
import type { RelatedDocumentResult, SearchResponseData, Source } from "../types/models.js";
import { searchResultsFromResponse } from "../query/search-service.js";

export function formatSourcesTable(sources: Source[]): string {
  const table = new Table({ head: ["ID", "TYPE", "NAME", "URI", "ENABLED", "TAGS"] });
  for (const source of sources) {
    table.push([source.id, source.type, source.name, source.uri, String(source.enabled), source.tags.join(",")]);
  }
  return table.toString();
}

export function formatSearchResults(response: SearchResponseData): string {
  const results = searchResultsFromResponse(response);
  return results.map((result, index) => [
    `${index + 1}. ${colors.bold(result.title)}`,
    `   URL: ${result.uri}`,
    `   Source: ${result.sourceType} | Published: ${result.publicationDate ?? "n/a"} | Score: ${result.score.toFixed(3)}`,
    "",
    ...result.snippet.split("\n").map((line) => line.length > 0 ? `   ${line}` : "")
  ].join("\n")).join(`\n\n${colors.dim("---")}\n\n`);
}

export function formatRelatedDocuments(results: RelatedDocumentResult[]): string {
  return results.map((result, index) => [
    `${index + 1}. ${colors.bold(result.title)}`,
    `   ${result.uri}`,
    `   Similarity: ${result.score.toFixed(3)}`
  ].join("\n")).join("\n\n");
}
