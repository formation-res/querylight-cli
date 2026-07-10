import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { Readable } from "node:stream";
import { readFile, readdir, stat } from "node:fs/promises";
import { createGunzip } from "node:zlib";
import path from "node:path";
import { unzipSync } from "fflate";
import streamValues from "stream-json/streamers/stream-values.js";
import * as yauzl from "yauzl";
import {
  SparseVectorFieldIndex,
  VectorFieldIndex,
  createSeededRandom,
  type SparseVectorFieldIndexState,
  type VectorFieldIndexState
} from "@tryformation/querylight-ts";
import { loadConfig, parseWorkspaceConfig } from "../core/config.js";
import { assertWorkspaceExists } from "../core/workspace.js";
import { isWorkspaceArchivePath, resolveReadableWorkspace } from "../core/archive.js";
import { CliError, ExitCode } from "../core/errors.js";
import { fileExists } from "../core/files.js";
import { hydrateIndexState, loadHydratedIndex, searchIndex, searchJsonRequest } from "../query/search-service.js";
import type { DocumentIndex, JsonDslRequest, JsonDslResponse } from "@tryformation/querylight-ts";
import { inferDenseVector } from "../vector/dense.js";
import { inferSparseVector } from "../vector/sparse.js";
import { denseVectorPath, readDensePayload, readSparsePayload, sparseVectorPath } from "../vector/store.js";
import type { RetrievalMode, SearchResponseData, SourceType, WorkspaceConfig } from "../types/models.js";

type ServedKnowledgeBase = {
  name: string;
  workspacePath: string;
  readableWorkspacePath: string;
  config: WorkspaceConfig;
  configuredIndexName: string;
  index?: DocumentIndex;
  indexLoad?: Promise<DocumentIndex>;
  loadIndex: () => Promise<DocumentIndex>;
  storage: "directory" | "archive";
};

type InferenceMode = "dense" | "sparse";

type InferenceRequest = {
  text?: string;
  input?: string;
  mode?: InferenceMode | "both";
  modes?: InferenceMode[];
};

type SimpleSearchDateField = "publicationDate" | "firstSeenAt" | "lastSeenAt" | "lastChangedAt" | "crawledAt";

type SimpleSearchRequest = {
  query: string;
  topK?: string | number;
  source?: string;
  sourceIds?: string[];
  sourceName?: string;
  sourceNames?: string[];
  sourceType?: string;
  sourceTypes?: SourceType[];
  uriPrefix?: string;
  uriPrefixes?: string[];
  tag?: string;
  tags?: string[];
  metadata?: Array<{ key: string; value: string }>;
  since?: string;
  until?: string;
  changedSince?: string;
  hasPublicationDate?: boolean;
  dateRanges: Array<{ field: SimpleSearchDateField; from?: string; to?: string }>;
  retrievalMode: RetrievalMode;
  showChunks: boolean;
};

export type SearchApiServerInfo = {
  mode: "single" | "multi";
  url: string;
  knowledgeBases: Array<{
    name: string;
    workspacePath: string;
    configuredIndexName: string;
    prefix: string;
    route: string;
    simpleSearchRoute: string;
    inferenceRoute: string;
    storage: "directory" | "archive";
  }>;
  close: () => Promise<void>;
};

type MountedWorkspaceArchive = {
  archivePath: string;
  workspaceEntryPrefix: string;
  entries: Record<string, Uint8Array>;
};

async function pathIsDirectory(candidatePath: string): Promise<boolean> {
  try {
    return (await stat(candidatePath)).isDirectory();
  } catch {
    return false;
  }
}

function assertSafeArchiveEntry(name: string): void {
  const normalized = path.posix.normalize(name);
  if (
    name.startsWith("/") ||
    normalized === "." ||
    normalized.startsWith("../") ||
    normalized.includes("/../")
  ) {
    throw new CliError(`unsafe archive entry: ${name}`, "WORKSPACE_ERROR", ExitCode.WorkspaceError);
  }
}

async function mountWorkspaceArchive(archivePath: string): Promise<MountedWorkspaceArchive> {
  const resolved = path.resolve(archivePath);
  const archive = await readFile(resolved);
  const entries = unzipSync(new Uint8Array(archive), {
    filter: (file) => {
      assertSafeArchiveEntry(file.name);
      return isMountedWorkspaceArchiveEntry(file.name);
    }
  });
  const workspaceEntryPrefix = resolveArchiveWorkspaceEntryPrefix(entries);
  return { archivePath: resolved, workspaceEntryPrefix, entries };
}

function isMountedWorkspaceArchiveEntry(entryName: string): boolean {
  return entryName === "config.yaml" || entryName.endsWith("/.kb/config.yaml");
}

function archiveEntry(mount: MountedWorkspaceArchive, entryName: string): Uint8Array {
  const entry = mount.entries[`${mount.workspaceEntryPrefix}${entryName}`];
  if (!entry) {
    throw Object.assign(new Error(`archive entry not found: ${entryName}`), { code: "ENOENT" });
  }
  return entry;
}

function archiveText(mount: MountedWorkspaceArchive, entryName: string): string {
  return Buffer.from(archiveEntry(mount, entryName)).toString("utf8");
}

function resolveArchiveWorkspaceEntryPrefix(entries: Record<string, Uint8Array>): string {
  if (entries["config.yaml"]) {
    return "";
  }
  const candidates = Object.keys(entries)
    .filter((entryName) => entryName.endsWith("/.kb/config.yaml"))
    .map((entryName) => entryName.slice(0, -"config.yaml".length))
    .sort();
  if (candidates.length === 1) {
    return candidates[0]!;
  }
  if (candidates.length > 1) {
    throw new CliError(
      `archive contains multiple .kb workspaces: ${candidates.map((candidate) => candidate.slice(0, -1)).join(", ")}`,
      "WORKSPACE_ERROR",
      ExitCode.WorkspaceError
    );
  }
  throw new CliError("archive workspace is missing config.yaml", "WORKSPACE_ERROR", ExitCode.WorkspaceError);
}

function openZip(archivePath: string): Promise<yauzl.ZipFile> {
  return new Promise((resolve, reject) => {
    yauzl.open(archivePath, { lazyEntries: true, autoClose: false }, (error, zipFile) => {
      if (error) {
        reject(error);
        return;
      }
      if (!zipFile) {
        reject(new CliError(`failed to open archive: ${archivePath}`, "WORKSPACE_ERROR", ExitCode.WorkspaceError));
        return;
      }
      resolve(zipFile);
    });
  });
}

function openReadStream(zipFile: yauzl.ZipFile, entry: yauzl.Entry): Promise<Readable> {
  return new Promise((resolve, reject) => {
    zipFile.openReadStream(entry, (error, stream) => {
      if (error) {
        reject(error);
        return;
      }
      if (!stream) {
        reject(new CliError(`failed to read archive entry: ${entry.fileName}`, "WORKSPACE_ERROR", ExitCode.WorkspaceError));
        return;
      }
      resolve(stream);
    });
  });
}

async function openFirstArchiveEntryReadStream(archivePath: string, entryNames: string[]): Promise<{ stream: Readable; entryName: string; close: () => void }> {
  const zipFile = await openZip(archivePath);

  try {
    const entry = await new Promise<yauzl.Entry>((resolve, reject) => {
      let bestEntry: yauzl.Entry | null = null;
      let bestPriority = Number.POSITIVE_INFINITY;

      zipFile.on("entry", (candidate) => {
        assertSafeArchiveEntry(candidate.fileName);
        const priority = entryNames.indexOf(candidate.fileName);
        if (priority === -1 || priority >= bestPriority) {
          zipFile.readEntry();
          return;
        }
        bestEntry = candidate;
        bestPriority = priority;
        zipFile.readEntry();
      });
      zipFile.once("end", () => {
        if (bestEntry) {
          resolve(bestEntry);
          return;
        }
        reject(Object.assign(new Error(`archive entry not found: ${entryNames[0]}`), { code: "ENOENT" }));
      });
      zipFile.once("error", reject);
      zipFile.readEntry();
    });
    const stream = await openReadStream(zipFile, entry);
    let closed = false;
    const close = () => {
      if (!closed) {
        closed = true;
        zipFile.close();
      }
    };
    stream.once("close", close);
    stream.once("error", close);
    return { stream, entryName: entry.fileName, close };
  } catch (error) {
    zipFile.close();
    throw error;
  }
}

async function parseJsonStream<T>(stream: Readable): Promise<T> {
  let value: T | undefined;
  for await (const item of stream.pipe(streamValues.withParserAsStream())) {
    value = (item as { value: T }).value;
  }
  if (value === undefined) {
    throw new CliError("JSON stream did not contain a value", "WORKSPACE_ERROR", ExitCode.WorkspaceError);
  }
  return value;
}

async function archiveJsonFromGzipOrFile<T>(mount: MountedWorkspaceArchive, gzipEntryName: string, legacyEntryName: string): Promise<T> {
  const { stream, entryName, close } = await openFirstArchiveEntryReadStream(mount.archivePath, [
    `${mount.workspaceEntryPrefix}${gzipEntryName}`,
    `${mount.workspaceEntryPrefix}${legacyEntryName}`
  ]);
  try {
    const jsonStream = entryName.endsWith(".gz") ? stream.pipe(createGunzip()) : stream;
    return await parseJsonStream<T>(jsonStream);
  } finally {
    close();
  }
}

async function getCachedIndex(knowledgeBase: ServedKnowledgeBase): Promise<DocumentIndex> {
  if (knowledgeBase.index) {
    return knowledgeBase.index;
  }
  knowledgeBase.indexLoad ??= knowledgeBase.loadIndex()
    .then((index) => {
      knowledgeBase.index = index;
      return index;
    })
    .catch((error: unknown) => {
      knowledgeBase.indexLoad = undefined;
      throw error;
    });
  return knowledgeBase.indexLoad;
}

async function loadSearchIndex(workspacePath: string): Promise<DocumentIndex> {
  const index = await loadHydratedIndex(workspacePath);
  if (await fileExists(denseVectorPath(workspacePath))) {
    const dense = await readDensePayload(workspacePath);
    index.mapping.embedding = new VectorFieldIndex({
      numHashTables: dense.metadata.hashTables,
      dimensions: dense.metadata.dimensions,
      random: createSeededRandom(dense.metadata.randomSeed)
    }).loadState(dense.indexState as unknown as VectorFieldIndexState);
  }
  if (await fileExists(sparseVectorPath(workspacePath))) {
    const sparse = await readSparsePayload(workspacePath);
    index.mapping.sparse = new SparseVectorFieldIndex().loadState(sparse.indexState as unknown as SparseVectorFieldIndexState);
  }
  return index;
}

async function loadArchivedKnowledgeBase(archivePath: string, name: string): Promise<ServedKnowledgeBase> {
  const { workspacePath } = await resolveReadableWorkspace(archivePath);
  const knowledgeBase = await loadDirectoryKnowledgeBase(workspacePath, name);
  return {
    ...knowledgeBase,
    workspacePath: archivePath,
    readableWorkspacePath: workspacePath,
    storage: "archive"
  };
}

async function loadDirectoryKnowledgeBase(workspacePath: string, name?: string): Promise<ServedKnowledgeBase> {
  const workspace = await assertWorkspaceExists(workspacePath);
  const config = await loadConfig(workspace);
  const index = await loadSearchIndex(workspace);
  return {
    name: name ?? config.index.name,
    workspacePath: workspace,
    readableWorkspacePath: workspace,
    config,
    configuredIndexName: config.index.name,
    index,
    loadIndex: async () => index,
    storage: "directory"
  };
}

async function discoverKnowledgeBases(workspacePath: string): Promise<{ mode: "single" | "multi"; knowledgeBases: ServedKnowledgeBase[] }> {
  const resolvedWorkspacePath = path.resolve(workspacePath);
  if (isWorkspaceArchivePath(resolvedWorkspacePath)) {
    return {
      mode: "single",
      knowledgeBases: [await loadArchivedKnowledgeBase(resolvedWorkspacePath, path.basename(resolvedWorkspacePath).replace(/\.zip$/i, ""))]
    };
  }

  try {
    return {
      mode: "single",
      knowledgeBases: [await loadDirectoryKnowledgeBase(resolvedWorkspacePath)]
    };
  } catch (error) {
    if (!(error instanceof CliError) || error.code !== "WORKSPACE_ERROR") {
      throw error;
    }
  }

  const resolvedRoot = resolvedWorkspacePath;
  if (!await pathIsDirectory(resolvedRoot)) {
    throw new CliError(`workspace path does not exist: ${resolvedRoot}`, "WORKSPACE_ERROR", ExitCode.WorkspaceError);
  }

  const entries = await readdir(resolvedRoot, { withFileTypes: true });
  const knowledgeBases = (await Promise.all(entries
    .filter((entry) => entry.isDirectory() || (entry.isFile() && isWorkspaceArchivePath(entry.name)))
    .map(async (entry) => {
      const candidateWorkspace = entry.isDirectory()
        ? path.join(resolvedRoot, entry.name, ".kb")
        : path.join(resolvedRoot, entry.name);
      const knowledgeBaseName = entry.isDirectory() ? entry.name : entry.name.replace(/\.zip$/i, "");
      try {
        return entry.isDirectory()
          ? await loadDirectoryKnowledgeBase(candidateWorkspace, knowledgeBaseName)
          : await loadArchivedKnowledgeBase(candidateWorkspace, knowledgeBaseName);
      } catch (error) {
        if (error instanceof CliError && error.code === "WORKSPACE_ERROR") {
          return null;
        }
        throw error;
      }
    })))
    .filter((knowledgeBase): knowledgeBase is ServedKnowledgeBase => knowledgeBase != null);

  if (knowledgeBases.length === 0) {
    throw new CliError(
      `no knowledge bases found at ${resolvedRoot}; use a .kb workspace, a .zip workspace, or a directory of .zip files or named subdirectories that each contain .kb`,
      "WORKSPACE_ERROR",
      ExitCode.WorkspaceError
    );
  }

  return { mode: "multi", knowledgeBases };
}

function sendJson(response: ServerResponse, statusCode: number, payload: unknown): void {
  response.statusCode = statusCode;
  response.setHeader("content-type", "application/json; charset=utf-8");
  response.end(JSON.stringify(payload));
}

function sendError(response: ServerResponse, statusCode: number, type: string, reason: string): void {
  sendJson(response, statusCode, {
    error: {
      type,
      reason
    },
    status: statusCode
  });
}

async function readRequestBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8");
}

function parseSearchRequest(raw: string): JsonDslRequest {
  const normalized = raw.trim();
  if (normalized.length === 0) {
    return {} as JsonDslRequest;
  }
  try {
    const parsed = JSON.parse(normalized) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("expected a JSON object");
    }
    return parsed as JsonDslRequest;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new CliError(`invalid JSON request: ${message}`, "INVALID_ARGUMENT", ExitCode.InvalidArguments);
  }
}

function parseJsonObject(raw: string): Record<string, unknown> {
  const normalized = raw.trim();
  if (normalized.length === 0) {
    return {};
  }
  try {
    const parsed = JSON.parse(normalized) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("expected a JSON object");
    }
    return parsed as Record<string, unknown>;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new CliError(`invalid JSON request: ${message}`, "INVALID_ARGUMENT", ExitCode.InvalidArguments);
  }
}

function parseInferenceRequest(raw: string): InferenceRequest {
  const normalized = raw.trim();
  if (normalized.length === 0) {
    throw new CliError("inference request body is required", "INVALID_ARGUMENT", ExitCode.InvalidArguments);
  }
  try {
    const parsed = JSON.parse(normalized) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("expected a JSON object");
    }
    return parsed as InferenceRequest;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new CliError(`invalid JSON request: ${message}`, "INVALID_ARGUMENT", ExitCode.InvalidArguments);
  }
}

function firstDefined<T>(...values: Array<T | undefined>): T | undefined {
  return values.find((value) => value !== undefined);
}

function optionValue(body: Record<string, unknown>, params: URLSearchParams, ...names: string[]): unknown {
  for (const name of names) {
    if (body[name] !== undefined) {
      return body[name];
    }
    const param = params.get(name);
    if (param !== null) {
      return param;
    }
  }
  return undefined;
}

function stringOption(body: Record<string, unknown>, params: URLSearchParams, ...names: string[]): string | undefined {
  const value = optionValue(body, params, ...names);
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value !== "string") {
    throw new CliError(`${names[0]} must be a string`, "INVALID_ARGUMENT", ExitCode.InvalidArguments);
  }
  return value;
}

function positiveIntegerOption(body: Record<string, unknown>, params: URLSearchParams, ...names: string[]): string | number | undefined {
  const value = optionValue(body, params, ...names);
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value === "string" || typeof value === "number") {
    return value;
  }
  throw new CliError(`${names[0]} must be a positive integer`, "INVALID_ARGUMENT", ExitCode.InvalidArguments);
}

function booleanOption(body: Record<string, unknown>, params: URLSearchParams, ...names: string[]): boolean {
  const value = optionValue(body, params, ...names);
  if (value === undefined || value === null) {
    return false;
  }
  if (typeof value === "boolean") {
    return value;
  }
  if (typeof value === "string") {
    if (value === "" || value === "true" || value === "1") {
      return true;
    }
    if (value === "false" || value === "0") {
      return false;
    }
  }
  throw new CliError(`${names[0]} must be a boolean`, "INVALID_ARGUMENT", ExitCode.InvalidArguments);
}

function parseCommaSeparatedList(input: string | undefined): string[] | undefined {
  const values = (input ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  return values.length > 0 ? values : undefined;
}

function stringListOption(body: Record<string, unknown>, params: URLSearchParams, singularName: string, pluralName: string): string[] | undefined {
  const value = optionValue(body, params, pluralName, singularName);
  if (value === undefined || value === null) {
    return undefined;
  }
  if (Array.isArray(value)) {
    const values = value.map((item) => {
      if (typeof item !== "string") {
        throw new CliError(`${pluralName} must contain strings`, "INVALID_ARGUMENT", ExitCode.InvalidArguments);
      }
      return item.trim();
    }).filter(Boolean);
    return values.length > 0 ? values : undefined;
  }
  if (typeof value === "string") {
    return parseCommaSeparatedList(value);
  }
  throw new CliError(`${pluralName} must be an array or comma-separated string`, "INVALID_ARGUMENT", ExitCode.InvalidArguments);
}

function parseSourceType(input: string): SourceType {
  const normalized = input === "page" ? "url" : input;
  const supported = new Set<SourceType>(["url", "website", "rss", "file", "directory", "markdown", "text"]);
  if (!supported.has(normalized as SourceType)) {
    throw new CliError(`unsupported source type: ${input}`, "INVALID_ARGUMENT", ExitCode.InvalidArguments);
  }
  return normalized as SourceType;
}

function parseSourceTypesOption(body: Record<string, unknown>, params: URLSearchParams): SourceType[] | undefined {
  return stringListOption(body, params, "sourceType", "sourceTypes")?.map(parseSourceType);
}

function parseRetrievalMode(input: string | undefined): RetrievalMode {
  if (!input) {
    return "hybrid";
  }
  const supported = new Set<RetrievalMode>(["lexical", "dense", "sparse", "hybrid"]);
  if (!supported.has(input as RetrievalMode)) {
    throw new CliError(`unsupported retrieval mode: ${input}`, "INVALID_ARGUMENT", ExitCode.InvalidArguments);
  }
  return input as RetrievalMode;
}

function parseDateValue(input: string, optionName: string): string {
  const parsed = new Date(input);
  if (Number.isNaN(parsed.getTime())) {
    throw new CliError(`invalid date for ${optionName}: ${input}`, "INVALID_ARGUMENT", ExitCode.InvalidArguments);
  }
  return parsed.toISOString();
}

function parseMetadataOption(body: Record<string, unknown>, params: URLSearchParams): Array<{ key: string; value: string }> | undefined {
  const value = optionValue(body, params, "metadata");
  if (value === undefined || value === null) {
    return undefined;
  }
  if (Array.isArray(value)) {
    return value.map((item) => {
      if (typeof item === "string") {
        const idx = item.indexOf("=");
        if (idx <= 0) {
          throw new CliError(`invalid metadata entry: ${item}`, "INVALID_ARGUMENT", ExitCode.InvalidArguments);
        }
        return { key: item.slice(0, idx), value: item.slice(idx + 1) };
      }
      if (item && typeof item === "object" && !Array.isArray(item)) {
        const entry = item as Record<string, unknown>;
        if (typeof entry.key === "string" && typeof entry.value === "string") {
          return { key: entry.key, value: entry.value };
        }
      }
      throw new CliError("metadata must contain key=value strings or { key, value } objects", "INVALID_ARGUMENT", ExitCode.InvalidArguments);
    });
  }
  if (typeof value === "string") {
    return parseCommaSeparatedList(value)?.map((item) => {
      const idx = item.indexOf("=");
      if (idx <= 0) {
        throw new CliError(`invalid metadata entry: ${item}`, "INVALID_ARGUMENT", ExitCode.InvalidArguments);
      }
      return { key: item.slice(0, idx), value: item.slice(idx + 1) };
    });
  }
  if (typeof value === "object") {
    return Object.entries(value).map(([key, entryValue]) => {
      if (typeof entryValue !== "string") {
        throw new CliError("metadata object values must be strings", "INVALID_ARGUMENT", ExitCode.InvalidArguments);
      }
      return { key, value: entryValue };
    });
  }
  throw new CliError("metadata must be an object, array, or comma-separated string", "INVALID_ARGUMENT", ExitCode.InvalidArguments);
}

function parseSimpleSearchDateRanges(body: Record<string, unknown>, params: URLSearchParams): Array<{ field: SimpleSearchDateField; from?: string; to?: string }> {
  const ranges: Array<{ field: SimpleSearchDateField; from?: string; to?: string }> = [];
  const since = stringOption(body, params, "since");
  const until = stringOption(body, params, "until");
  if (since || until) {
    ranges.push({
      field: "publicationDate",
      from: since ? parseDateValue(since, "since") : undefined,
      to: until ? parseDateValue(until, "until") : undefined
    });
  }
  const changedSince = stringOption(body, params, "changedSince", "changed-since");
  if (changedSince) {
    ranges.push({ field: "lastChangedAt", from: parseDateValue(changedSince, "changedSince") });
  }
  const dateFieldOptions: Array<{ field: SimpleSearchDateField; from: string[]; to: string[] }> = [
    { field: "publicationDate", from: ["publicationDateFrom", "publication-date-from"], to: ["publicationDateTo", "publication-date-to"] },
    { field: "firstSeenAt", from: ["firstSeenAtFrom", "first-seen-at-from"], to: ["firstSeenAtTo", "first-seen-at-to"] },
    { field: "lastSeenAt", from: ["lastSeenAtFrom", "last-seen-at-from"], to: ["lastSeenAtTo", "last-seen-at-to"] },
    { field: "lastChangedAt", from: ["lastChangedAtFrom", "last-changed-at-from"], to: ["lastChangedAtTo", "last-changed-at-to"] },
    { field: "crawledAt", from: ["crawledAtFrom", "crawled-at-from"], to: ["crawledAtTo", "crawled-at-to"] }
  ];
  for (const option of dateFieldOptions) {
    const from = stringOption(body, params, ...option.from);
    const to = stringOption(body, params, ...option.to);
    if (!from && !to) {
      continue;
    }
    ranges.push({
      field: option.field,
      from: from ? parseDateValue(from, option.from[0]!) : undefined,
      to: to ? parseDateValue(to, option.to[0]!) : undefined
    });
  }
  return ranges;
}

function parseOptionalPositiveInteger(input: string | number | undefined, optionName: string): number | undefined {
  if (input === undefined) {
    return undefined;
  }
  const value = Number(input);
  if (!Number.isInteger(value) || value < 1) {
    throw new CliError(`invalid positive integer for ${optionName}: ${input}`, "INVALID_ARGUMENT", ExitCode.InvalidArguments);
  }
  return value;
}

function resolveSimpleSearchTopK(input: string | number | undefined, sourceTypes: SourceType[] | undefined, dateRanges: Array<{ field: SimpleSearchDateField; from?: string; to?: string }>, defaultTopK: number): number {
  const explicitTopK = parseOptionalPositiveInteger(input, "topK");
  if (explicitTopK !== undefined) {
    return explicitTopK;
  }
  if ((sourceTypes ?? []).includes("rss") && dateRanges.length > 0) {
    return 500;
  }
  return defaultTopK;
}

function parseSimpleSearchRequest(raw: string, params: URLSearchParams): SimpleSearchRequest {
  const body = parseJsonObject(raw);
  const sourceTypes = parseSourceTypesOption(body, params);
  const dateRanges = parseSimpleSearchDateRanges(body, params);
  const retrieval = firstDefined(
    stringOption(body, params, "retrieval"),
    stringOption(body, params, "retrievalMode", "retrieval-mode")
  );
  return {
    query: stringOption(body, params, "query", "q") ?? "",
    topK: positiveIntegerOption(body, params, "topK", "top-k", "size"),
    source: stringOption(body, params, "source"),
    sourceIds: stringListOption(body, params, "sourceId", "sourceIds"),
    sourceName: stringOption(body, params, "sourceName", "source-name"),
    sourceNames: stringListOption(body, params, "sourceName", "sourceNames"),
    sourceType: stringOption(body, params, "sourceType", "source-type"),
    sourceTypes,
    uriPrefix: stringOption(body, params, "uriPrefix", "uri-prefix"),
    uriPrefixes: stringListOption(body, params, "uriPrefix", "uriPrefixes"),
    hasPublicationDate: booleanOption(body, params, "hasPublicationDate", "has-publication-date"),
    tag: stringOption(body, params, "tag"),
    tags: stringListOption(body, params, "tag", "tags"),
    metadata: parseMetadataOption(body, params),
    since: stringOption(body, params, "since"),
    until: stringOption(body, params, "until"),
    changedSince: stringOption(body, params, "changedSince", "changed-since"),
    dateRanges,
    retrievalMode: parseRetrievalMode(retrieval),
    showChunks: booleanOption(body, params, "showChunks", "show-chunks")
  };
}

function requestedInferenceModes(request: InferenceRequest): InferenceMode[] {
  if (request.modes !== undefined) {
    if (!Array.isArray(request.modes) || request.modes.some((mode) => mode !== "dense" && mode !== "sparse")) {
      throw new CliError("modes must be an array containing dense and/or sparse", "INVALID_ARGUMENT", ExitCode.InvalidArguments);
    }
    return [...new Set(request.modes)];
  }
  if (request.mode === undefined || request.mode === "both") {
    return ["dense", "sparse"];
  }
  if (request.mode !== "dense" && request.mode !== "sparse") {
    throw new CliError("mode must be dense, sparse, or both", "INVALID_ARGUMENT", ExitCode.InvalidArguments);
  }
  return [request.mode];
}

function routeForKnowledgeBase(mode: "single" | "multi", knowledgeBase: ServedKnowledgeBase): string {
  return mode === "single" ? "/_search" : `/${knowledgeBase.name}/_search`;
}

function simpleSearchRouteForKnowledgeBase(mode: "single" | "multi", knowledgeBase: ServedKnowledgeBase): string {
  return mode === "single" ? "/_simplesearch" : `/${knowledgeBase.name}/_simplesearch`;
}

function inferenceRouteForKnowledgeBase(mode: "single" | "multi", knowledgeBase: ServedKnowledgeBase): string {
  return mode === "single" ? "/_infer" : `/${knowledgeBase.name}/_infer`;
}

function prefixForKnowledgeBase(mode: "single" | "multi", knowledgeBase: ServedKnowledgeBase): string {
  return mode === "single" ? "" : `/${knowledgeBase.name}`;
}

function publicKnowledgeBases(mode: "single" | "multi", knowledgeBases: ServedKnowledgeBase[]): SearchApiServerInfo["knowledgeBases"] {
  return knowledgeBases.map((knowledgeBase) => ({
    name: knowledgeBase.name,
    workspacePath: knowledgeBase.workspacePath,
    configuredIndexName: knowledgeBase.configuredIndexName,
    prefix: prefixForKnowledgeBase(mode, knowledgeBase),
    route: routeForKnowledgeBase(mode, knowledgeBase),
    simpleSearchRoute: simpleSearchRouteForKnowledgeBase(mode, knowledgeBase),
    inferenceRoute: inferenceRouteForKnowledgeBase(mode, knowledgeBase),
    storage: knowledgeBase.storage
  }));
}

function handleKnowledgeBaseList(
  response: ServerResponse,
  mode: "single" | "multi",
  knowledgeBases: ServedKnowledgeBase[]
): void {
  const listed = publicKnowledgeBases(mode, knowledgeBases);
  sendJson(response, 200, {
    mode,
    prefixes: listed.map((knowledgeBase) => knowledgeBase.prefix),
    knowledgeBases: listed
  });
}

function buildHelpPayload(
  mode: "single" | "multi",
  knowledgeBases: ServedKnowledgeBase[],
  selectedKnowledgeBase?: ServedKnowledgeBase
): Record<string, unknown> {
  const listed = publicKnowledgeBases(mode, knowledgeBases);
  const selected = selectedKnowledgeBase
    ? publicKnowledgeBases(mode, [selectedKnowledgeBase])[0]
    : undefined;
  const searchRoutes = selected
    ? [selected.route]
    : listed.map((knowledgeBase) => knowledgeBase.route);
  const simpleSearchRoutes = selected
    ? [selected.simpleSearchRoute]
    : listed.map((knowledgeBase) => knowledgeBase.simpleSearchRoute);
  const inferenceRoutes = selected
    ? [selected.inferenceRoute]
    : listed.map((knowledgeBase) => knowledgeBase.inferenceRoute);

  return {
    name: "Querylight Search API",
    mode,
    description: "HTTP access to Querylight simple search and JSON DSL search.",
    capabilities: {
      search: {
        routes: searchRoutes,
        methods: ["GET", "POST"],
        requestBody: "Querylight JSON DSL object. An empty body returns default match_all results.",
        clauses: ["query", "knn", "sparse_vector", "neural_sparse", "rrf", "vector_rescore", "sparse_vector_rescore"],
        vectorFields: {
          dense: "embedding",
          sparse: "sparse"
        },
        response: "OpenSearch-like hits with stored Querylight chunk and document fields."
      },
      simpleSearch: {
        routes: simpleSearchRoutes,
        methods: ["GET", "POST"],
        requestBody: {
          query: "Text query. Omit it to list the latest matching documents.",
          topK: "Maximum number of results. Defaults to search.defaultTopK. RSS searches with a time window use 500 when omitted.",
          retrieval: "Optional. lexical, dense, sparse, or hybrid. Defaults to hybrid.",
          filters: ["source", "sourceName", "sourceType", "uriPrefix", "tag", "metadata", "since", "until", "changedSince", "hasPublicationDate"],
          showChunks: "Optional boolean. Returns chunk-level matches when true."
        },
        response: "The same SearchResponseData shape returned by qli search --json."
      },
      inference: {
        routes: inferenceRoutes,
        method: "POST",
        requestBody: {
          text: "Query text to encode.",
          mode: "Optional. dense, sparse, or both. Defaults to both.",
          modes: "Optional array containing dense and/or sparse."
        },
        response: "Dense vectors and/or sparse token-weight maps for use in _search vector clauses."
      },
      knowledgeBases: {
        route: "/_knowledge_bases",
        method: "GET",
        description: "Lists mounted knowledge base prefixes and search routes."
      },
      help: {
        routes: mode === "single" ? ["/_help", "/<configured-index-name>/_help"] : ["/_help", "/<directory-name>/_help"],
        method: "GET",
        description: "Returns this help payload."
      },
      vectors: {
        request: "Vector clauses use Elasticsearch-style JSON DSL. Send dense vectors in knn.vector and sparse token weights in sparse_vector.vector or neural_sparse.vector.",
        production: "Use _infer to produce dense vectors or sparse token-weight maps before submitting vector queries to _search.",
        rrf: "Use query.rrf.queries to combine lexical, dense, and sparse clauses with reciprocal rank fusion.",
        servedFields: "qli serve loads dense artifacts into the embedding field and sparse artifacts into the sparse field when those artifacts exist."
      }
    },
    fields: [
      "text",
      "title",
      "uri",
      "sourceId",
      "sourceName",
      "sourceType",
      "tags",
      "publicationDate",
      "firstSeenAt",
      "lastSeenAt",
      "lastChangedAt",
      "crawledAt",
      "metadata.<key>"
    ],
    queryExamples: {
      inference: [
        {
          name: "Produce dense and sparse query vectors",
          method: "POST",
          route: inferenceRoutes[0] ?? "/_infer",
          body: {
            text: "authentication flow",
            mode: "both"
          }
        },
        {
          name: "Produce only a dense vector",
          method: "POST",
          route: inferenceRoutes[0] ?? "/_infer",
          body: {
            text: "authentication flow",
            mode: "dense"
          }
        }
      ],
      httpWithoutVectors: [
        {
          name: "Simple hybrid search",
          method: "POST",
          route: simpleSearchRoutes[0] ?? "/_simplesearch",
          body: {
            query: "authentication",
            topK: 5
          }
        },
        {
          name: "Keyword search",
          method: "POST",
          route: searchRoutes[0] ?? "/_search",
          body: {
            query: {
              match: {
                text: "authentication"
              }
            },
            size: 5,
            highlight: {
              fields: {
                text: {}
              }
            }
          }
        },
        {
          name: "Filter by source type",
          method: "POST",
          route: searchRoutes[0] ?? "/_search",
          body: {
            query: {
              bool: {
                must: [
                  {
                    match: {
                      text: "pricing"
                    }
                  }
                ],
                filter: [
                  {
                    term: {
                      sourceType: "rss"
                    }
                  }
                ]
              }
            },
            size: 10
          }
        },
        {
          name: "Aggregate by source type",
          method: "POST",
          route: searchRoutes[0] ?? "/_search",
          body: {
            query: {
              match_all: {}
            },
            size: 0,
            aggs: {
              types: {
                terms: {
                  field: "sourceType",
                  size: 10
                }
              }
            }
          }
        }
      ],
      vectorDsl: [
        {
          name: "Dense vector search",
          method: "POST",
          route: searchRoutes[0] ?? "/_search",
          body: {
            knn: {
              field: "embedding",
              vector: [0.12, -0.04, 0.98],
              k: 10
            },
            size: 10
          }
        },
        {
          name: "Sparse vector search",
          method: "POST",
          route: searchRoutes[0] ?? "/_search",
          body: {
            sparse_vector: {
              field: "sparse",
              vector: {
                "42": 0.91,
                "314": 0.62
              },
              k: 10
            },
            size: 10
          }
        },
        {
          name: "Hybrid search with reciprocal rank fusion",
          method: "POST",
          route: searchRoutes[0] ?? "/_search",
          body: {
            query: {
              rrf: {
                queries: [
                  {
                    match: {
                      text: {
                        query: "authentication flow",
                        operator: "and"
                      }
                    }
                  },
                  {
                    knn: {
                      field: "embedding",
                      vector: [0.12, -0.04, 0.98],
                      k: 50
                    }
                  },
                  {
                    sparse_vector: {
                      field: "sparse",
                      vector: {
                        "42": 0.91,
                        "314": 0.62
                      },
                      k: 50
                    }
                  }
                ],
                rank_constant: 20,
                weights: [3, 1, 1]
              }
            },
            size: 10
          }
        }
      ]
    },
    vectorSetup: {
      cli: [
        "qli models pull --dense --sparse",
        "qli rebuild --dense --sparse"
      ],
      serveFields: [
        "Dense vector artifacts are served from the embedding field.",
        "Sparse vector artifacts are served from the sparse field.",
        "Use _infer to turn query text into dense vectors or sparse token-weight maps before _search.",
        "Keep _search compatible with the JSON DSL instead of adding retrieval or retrievalMode request flags."
      ]
    },
    notes: [
      "_search passes the request to the Querylight JSON DSL executor.",
      "_simplesearch accepts qli search options, defaults to hybrid retrieval, and performs vector inference inside the request.",
      "Do not use non-standard retrieval or retrievalMode flags in _search bodies.",
      "The vector examples use short sample vectors. Use _infer output in real requests.",
      "Call _infer first when a caller has text and needs dense or sparse query vectors.",
      "In multi-KB mode, each child directory or .zip file has its own route prefix.",
      "Packaged .zip knowledge bases are mounted read-only."
    ],
    knowledgeBases: selected ? [selected] : listed
  };
}

function resolveKnowledgeBaseForHelpPath(
  pathname: string,
  mode: "single" | "multi",
  knowledgeBases: Map<string, ServedKnowledgeBase>
): ServedKnowledgeBase | undefined | null {
  const segments = pathname.split("/").filter(Boolean);
  if (segments.length === 1 && segments[0] === "_help") {
    return undefined;
  }
  if (mode === "single") {
    const knowledgeBase = [...knowledgeBases.values()][0];
    if (segments.length === 2 && segments[1] === "_help" && knowledgeBase && segments[0] === knowledgeBase.configuredIndexName) {
      return knowledgeBase;
    }
    return null;
  }
  if (segments.length === 2 && segments[1] === "_help") {
    return knowledgeBases.get(segments[0]!) ?? null;
  }
  return null;
}

function handleHelpRequest(
  request: IncomingMessage,
  response: ServerResponse,
  pathname: string,
  mode: "single" | "multi",
  knowledgeBases: ServedKnowledgeBase[],
  knowledgeBasesByName: Map<string, ServedKnowledgeBase>
): void {
  if (request.method !== "GET") {
    response.setHeader("allow", "GET");
    sendError(response, 405, "method_not_allowed", `unsupported method for ${pathname}`);
    return;
  }
  const selected = resolveKnowledgeBaseForHelpPath(pathname, mode, knowledgeBasesByName);
  if (selected === null) {
    sendError(response, 404, "resource_not_found_exception", `unknown help route: ${pathname}`);
    return;
  }
  sendJson(response, 200, buildHelpPayload(mode, knowledgeBases, selected));
}

function resolveKnowledgeBaseForPath(
  pathname: string,
  mode: "single" | "multi",
  knowledgeBases: Map<string, ServedKnowledgeBase>
): ServedKnowledgeBase | null {
  const segments = pathname.split("/").filter(Boolean);
  if (mode === "single") {
    const knowledgeBase = [...knowledgeBases.values()][0];
    if (!knowledgeBase) {
      return null;
    }
    if (segments.length === 1 && segments[0] === "_search") {
      return knowledgeBase;
    }
    if (segments.length === 2 && segments[1] === "_search" && segments[0] === knowledgeBase.configuredIndexName) {
      return knowledgeBase;
    }
    return null;
  }

  if (segments.length === 2 && segments[1] === "_search") {
    return knowledgeBases.get(segments[0]!) ?? null;
  }
  return null;
}

function resolveKnowledgeBaseForSimpleSearchPath(
  pathname: string,
  mode: "single" | "multi",
  knowledgeBases: Map<string, ServedKnowledgeBase>
): ServedKnowledgeBase | null {
  const segments = pathname.split("/").filter(Boolean);
  if (mode === "single") {
    const knowledgeBase = [...knowledgeBases.values()][0];
    if (!knowledgeBase) {
      return null;
    }
    if (segments.length === 1 && segments[0] === "_simplesearch") {
      return knowledgeBase;
    }
    if (segments.length === 2 && segments[1] === "_simplesearch" && segments[0] === knowledgeBase.configuredIndexName) {
      return knowledgeBase;
    }
    return null;
  }

  if (segments.length === 2 && segments[1] === "_simplesearch") {
    return knowledgeBases.get(segments[0]!) ?? null;
  }
  return null;
}

function resolveKnowledgeBaseForInferencePath(
  pathname: string,
  mode: "single" | "multi",
  knowledgeBases: Map<string, ServedKnowledgeBase>
): ServedKnowledgeBase | null {
  const segments = pathname.split("/").filter(Boolean);
  if (mode === "single") {
    const knowledgeBase = [...knowledgeBases.values()][0];
    if (!knowledgeBase) {
      return null;
    }
    if (segments.length === 1 && segments[0] === "_infer") {
      return knowledgeBase;
    }
    if (segments.length === 2 && segments[1] === "_infer" && segments[0] === knowledgeBase.configuredIndexName) {
      return knowledgeBase;
    }
    return null;
  }

  if (segments.length === 2 && segments[1] === "_infer") {
    return knowledgeBases.get(segments[0]!) ?? null;
  }
  return null;
}

async function handleInferenceRequest(
  request: IncomingMessage,
  response: ServerResponse,
  pathname: string,
  mode: "single" | "multi",
  knowledgeBases: Map<string, ServedKnowledgeBase>
): Promise<void> {
  if (request.method !== "POST") {
    response.setHeader("allow", "POST");
    sendError(response, 405, "method_not_allowed", `unsupported method for ${pathname}`);
    return;
  }

  const knowledgeBase = resolveKnowledgeBaseForInferencePath(pathname, mode, knowledgeBases);
  if (!knowledgeBase) {
    sendError(response, 404, "resource_not_found_exception", `unknown inference route: ${pathname}`);
    return;
  }

  try {
    const requestBody = parseInferenceRequest(await readRequestBody(request));
    const text = requestBody.text ?? requestBody.input;
    if (typeof text !== "string" || text.trim().length === 0) {
      throw new CliError("text is required", "INVALID_ARGUMENT", ExitCode.InvalidArguments);
    }
    const modes = requestedInferenceModes(requestBody);
    const payload: Record<string, unknown> = {
      text,
      fields: {
        dense: "embedding",
        sparse: "sparse"
      }
    };
    if (modes.includes("dense")) {
      payload.dense = {
        modelId: knowledgeBase.config.retrieval.dense.modelId,
        vector: await inferDenseVector({
          workspacePath: knowledgeBase.readableWorkspacePath,
          config: knowledgeBase.config.retrieval.dense,
          text
        })
      };
    }
    if (modes.includes("sparse")) {
      payload.sparse = {
        modelId: knowledgeBase.config.retrieval.sparse.modelId,
        vector: await inferSparseVector({
          workspacePath: knowledgeBase.readableWorkspacePath,
          config: knowledgeBase.config.retrieval.sparse,
          text
        })
      };
    }
    sendJson(response, 200, payload);
  } catch (error) {
    if (error instanceof CliError && error.code === "INVALID_ARGUMENT") {
      sendError(response, 400, "parse_exception", error.message);
      return;
    }
    const message = error instanceof Error ? error.message : String(error);
    sendError(response, 500, "inference_execution_exception", message);
  }
}

async function handleSearchRequest(
  request: IncomingMessage,
  response: ServerResponse,
  pathname: string,
  mode: "single" | "multi",
  knowledgeBases: Map<string, ServedKnowledgeBase>
): Promise<void> {
  if (request.method !== "GET" && request.method !== "POST") {
    response.setHeader("allow", "GET, POST");
    sendError(response, 405, "method_not_allowed", `unsupported method for ${pathname}`);
    return;
  }

  const knowledgeBase = resolveKnowledgeBaseForPath(pathname, mode, knowledgeBases);
  if (!knowledgeBase) {
    sendError(response, 404, "resource_not_found_exception", `unknown search route: ${pathname}`);
    return;
  }

  try {
    const requestBody = parseSearchRequest(await readRequestBody(request));
    const indexName = mode === "multi" ? knowledgeBase.name : knowledgeBase.configuredIndexName;
    const index = await getCachedIndex(knowledgeBase);
    const result: JsonDslResponse = await searchJsonRequest({
      index,
      request: requestBody,
      indexName
    });
    sendJson(response, 200, result);
  } catch (error) {
    if (error instanceof CliError && error.code === "INVALID_ARGUMENT") {
      sendError(response, 400, "parse_exception", error.message);
      return;
    }
    const message = error instanceof Error ? error.message : String(error);
    sendError(response, 500, "search_phase_execution_exception", message);
  }
}

async function handleSimpleSearchRequest(
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
  mode: "single" | "multi",
  knowledgeBases: Map<string, ServedKnowledgeBase>
): Promise<void> {
  if (request.method !== "GET" && request.method !== "POST") {
    response.setHeader("allow", "GET, POST");
    sendError(response, 405, "method_not_allowed", `unsupported method for ${url.pathname}`);
    return;
  }

  const knowledgeBase = resolveKnowledgeBaseForSimpleSearchPath(url.pathname, mode, knowledgeBases);
  if (!knowledgeBase) {
    sendError(response, 404, "resource_not_found_exception", `unknown simple search route: ${url.pathname}`);
    return;
  }

  try {
    const simpleRequest = parseSimpleSearchRequest(await readRequestBody(request), url.searchParams);
    const result: SearchResponseData = await searchIndex({
      workspacePath: knowledgeBase.readableWorkspacePath,
      query: simpleRequest.query,
      topK: resolveSimpleSearchTopK(simpleRequest.topK, simpleRequest.sourceTypes, simpleRequest.dateRanges, knowledgeBase.config.search.defaultTopK),
      sourceIds: firstDefined(simpleRequest.sourceIds, parseCommaSeparatedList(simpleRequest.source)),
      sourceNames: firstDefined(simpleRequest.sourceNames, parseCommaSeparatedList(simpleRequest.sourceName)),
      sourceTypes: firstDefined(simpleRequest.sourceTypes, simpleRequest.sourceType ? [parseSourceType(simpleRequest.sourceType)] : undefined),
      uriPrefixes: firstDefined(simpleRequest.uriPrefixes, parseCommaSeparatedList(simpleRequest.uriPrefix)),
      hasPublicationDate: simpleRequest.hasPublicationDate,
      tags: firstDefined(simpleRequest.tags, parseCommaSeparatedList(simpleRequest.tag)),
      metadata: simpleRequest.metadata,
      dateRanges: simpleRequest.dateRanges,
      retrievalMode: simpleRequest.retrievalMode,
      showChunks: simpleRequest.showChunks
    });
    sendJson(response, 200, result);
  } catch (error) {
    if (error instanceof CliError && error.code === "INVALID_ARGUMENT") {
      sendError(response, 400, "parse_exception", error.message);
      return;
    }
    const message = error instanceof Error ? error.message : String(error);
    sendError(response, 500, "search_phase_execution_exception", message);
  }
}

export async function startSearchApiServer(
  {
    workspacePath,
    host = "127.0.0.1",
    port = 3000
  }: {
    workspacePath: string;
    host?: string;
    port?: number;
  }
): Promise<SearchApiServerInfo> {
  const { mode, knowledgeBases } = await discoverKnowledgeBases(workspacePath);
  const byName = new Map(knowledgeBases.map((knowledgeBase) => [knowledgeBase.name, knowledgeBase]));
  const server: Server = createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", `http://${request.headers.host ?? `${host}:${port}`}`);
    if (url.pathname === "/_knowledge_bases") {
      if (request.method !== "GET") {
        response.setHeader("allow", "GET");
        sendError(response, 405, "method_not_allowed", `unsupported method for ${url.pathname}`);
        return;
      }
      handleKnowledgeBaseList(response, mode, knowledgeBases);
      return;
    }
    if (url.pathname === "/_help" || url.pathname.endsWith("/_help")) {
      handleHelpRequest(request, response, url.pathname, mode, knowledgeBases, byName);
      return;
    }
    if (url.pathname === "/_infer" || url.pathname.endsWith("/_infer")) {
      await handleInferenceRequest(request, response, url.pathname, mode, byName);
      return;
    }
    if (url.pathname === "/_simplesearch" || url.pathname.endsWith("/_simplesearch")) {
      await handleSimpleSearchRequest(request, response, url, mode, byName);
      return;
    }
    await handleSearchRequest(request, response, url.pathname, mode, byName);
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.off("error", reject);
      resolve();
    });
  });

  const address = server.address();
  if (!address || typeof address === "string") {
    throw new CliError("server failed to bind to a TCP address", "SERVER_ERROR", ExitCode.GeneralError);
  }
  const url = `http://${host}:${address.port}`;

  return {
    mode,
    url,
    knowledgeBases: publicKnowledgeBases(mode, knowledgeBases),
    close: async () => new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    })
  };
}
