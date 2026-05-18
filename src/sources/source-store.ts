import path from "node:path";
import type { Source } from "../types/models.js";
import { stableId } from "../core/ids.js";
import { readJsonl, writeJsonl } from "../core/jsonl.js";
import { CliError, ExitCode } from "../core/errors.js";

const sourcesFile = (workspacePath: string): string => path.join(workspacePath, "sources", "sources.jsonl");

export async function listSources(workspacePath: string): Promise<Source[]> {
  return readJsonl<Source>(sourcesFile(workspacePath));
}

export async function addSource(workspacePath: string, source: Omit<Source, "id"> & { id?: string }): Promise<Source> {
  const existing = await listSources(workspacePath);
  if (existing.some((candidate) => candidate.uri === source.uri)) {
    throw new CliError(`duplicate source URI: ${source.uri}`, "DUPLICATE_SOURCE", ExitCode.SourceError);
  }
  const id = source.id ?? stableId("src", source.type, source.uri);
  const stored: Source = { ...source, id };
  existing.push(stored);
  await writeJsonl(sourcesFile(workspacePath), existing);
  return stored;
}

export async function updateSource(workspacePath: string, sourceId: string, patch: Partial<Source>): Promise<Source> {
  const sources = await listSources(workspacePath);
  const index = sources.findIndex((source) => source.id === sourceId);
  if (index < 0) {
    throw new CliError(`source not found: ${sourceId}`, "SOURCE_NOT_FOUND", ExitCode.SourceError);
  }
  const updated = { ...sources[index]!, ...patch, id: sourceId };
  sources[index] = updated;
  await writeJsonl(sourcesFile(workspacePath), sources);
  return updated;
}

export async function removeSource(workspacePath: string, sourceId: string): Promise<void> {
  const sources = await listSources(workspacePath);
  const filtered = sources.filter((source) => source.id !== sourceId);
  if (filtered.length === sources.length) {
    throw new CliError(`source not found: ${sourceId}`, "SOURCE_NOT_FOUND", ExitCode.SourceError);
  }
  await writeJsonl(sourcesFile(workspacePath), filtered);
}
