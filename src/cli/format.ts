import Table from "cli-table3";
import colors from "picocolors";
import type { SearchResult, Source } from "../types/models.js";

export function formatSourcesTable(sources: Source[]): string {
  const table = new Table({ head: ["ID", "TYPE", "NAME", "URI", "ENABLED", "TAGS"] });
  for (const source of sources) {
    table.push([source.id, source.type, source.name, source.uri, String(source.enabled), source.tags.join(",")]);
  }
  return table.toString();
}

export function formatSearchResults(results: SearchResult[]): string {
  return results.map((result, index) => [
    `${index + 1}. ${colors.bold(result.title)}`,
    `   ${result.uri}`,
    `   Score: ${result.score.toFixed(3)}`,
    `   ${result.snippet}`
  ].join("\n")).join("\n\n");
}
