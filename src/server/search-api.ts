import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { readdir, stat } from "node:fs/promises";
import path from "node:path";
import { loadConfig } from "../core/config.js";
import { assertWorkspaceExists } from "../core/workspace.js";
import { isWorkspaceArchivePath, resolveReadableWorkspace } from "../core/archive.js";
import { CliError, ExitCode } from "../core/errors.js";
import { loadHydratedIndex, searchJsonRequest } from "../query/search-service.js";
import type { DocumentIndex, JsonDslRequest, JsonDslResponse } from "@tryformation/querylight-ts";

type ServedKnowledgeBase = {
  name: string;
  workspacePath: string;
  configuredIndexName: string;
  index: DocumentIndex;
};

export type SearchApiServerInfo = {
  mode: "single" | "multi";
  url: string;
  knowledgeBases: Array<{
    name: string;
    workspacePath: string;
    route: string;
  }>;
  close: () => Promise<void>;
};

async function pathIsDirectory(candidatePath: string): Promise<boolean> {
  try {
    return (await stat(candidatePath)).isDirectory();
  } catch {
    return false;
  }
}

async function discoverKnowledgeBases(workspacePath: string): Promise<{ mode: "single" | "multi"; knowledgeBases: ServedKnowledgeBase[] }> {
  try {
    const singleWorkspace = (await resolveReadableWorkspace(workspacePath)).workspacePath;
    const config = await loadConfig(singleWorkspace);
    const index = await loadHydratedIndex(singleWorkspace);
    return {
      mode: "single",
      knowledgeBases: [{
        name: config.index.name,
        workspacePath: singleWorkspace,
        configuredIndexName: config.index.name,
        index
      }]
    };
  } catch (error) {
    if (!(error instanceof CliError) || error.code !== "WORKSPACE_ERROR") {
      throw error;
    }
  }

  const resolvedRoot = path.resolve(workspacePath);
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
        const workspace = entry.isDirectory()
          ? await assertWorkspaceExists(candidateWorkspace)
          : (await resolveReadableWorkspace(candidateWorkspace)).workspacePath;
        const config = await loadConfig(workspace);
        const index = await loadHydratedIndex(workspace);
        return {
          name: knowledgeBaseName,
          workspacePath: workspace,
          configuredIndexName: config.index.name,
          index
        } satisfies ServedKnowledgeBase;
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
    const result: JsonDslResponse = await searchJsonRequest({
      index: knowledgeBase.index,
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
    knowledgeBases: knowledgeBases.map((knowledgeBase) => ({
      name: knowledgeBase.name,
      workspacePath: knowledgeBase.workspacePath,
      route: routeForKnowledgeBase(mode, knowledgeBase)
    })),
    close: async () => new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    })
  };
}
