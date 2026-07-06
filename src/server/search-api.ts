import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { Readable } from "node:stream";
import { readFile, readdir, stat } from "node:fs/promises";
import { createGunzip } from "node:zlib";
import path from "node:path";
import { unzipSync } from "fflate";
import streamValues from "stream-json/streamers/stream-values.js";
import * as yauzl from "yauzl";
import { loadConfig, parseWorkspaceConfig } from "../core/config.js";
import { assertWorkspaceExists } from "../core/workspace.js";
import { isWorkspaceArchivePath, resolveReadableWorkspace } from "../core/archive.js";
import { CliError, ExitCode } from "../core/errors.js";
import { hydrateIndexState, loadHydratedIndex, searchJsonRequest } from "../query/search-service.js";
import type { DocumentIndex, JsonDslRequest, JsonDslResponse } from "@tryformation/querylight-ts";

type ServedKnowledgeBase = {
  name: string;
  workspacePath: string;
  configuredIndexName: string;
  index?: DocumentIndex;
  indexLoad?: Promise<DocumentIndex>;
  loadIndex: () => Promise<DocumentIndex>;
  storage: "directory" | "archive";
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

async function loadArchivedKnowledgeBase(archivePath: string, name: string): Promise<ServedKnowledgeBase> {
  const { workspacePath } = await resolveReadableWorkspace(archivePath);
  const knowledgeBase = await loadDirectoryKnowledgeBase(workspacePath, name);
  return {
    ...knowledgeBase,
    workspacePath: archivePath,
    storage: "archive"
  };
}

async function loadDirectoryKnowledgeBase(workspacePath: string, name?: string): Promise<ServedKnowledgeBase> {
  const workspace = await assertWorkspaceExists(workspacePath);
  const config = await loadConfig(workspace);
  const index = await loadHydratedIndex(workspace);
  return {
    name: name ?? config.index.name,
    workspacePath: workspace,
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

function routeForKnowledgeBase(mode: "single" | "multi", knowledgeBase: ServedKnowledgeBase): string {
  return mode === "single" ? "/_search" : `/${knowledgeBase.name}/_search`;
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
