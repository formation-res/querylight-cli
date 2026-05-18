import { Command } from "commander";
import { stat } from "node:fs/promises";
import path from "node:path";
import { chunkDocuments } from "../chunk/chunker.js";
import { DEFAULT_WORKSPACE, PACKAGE_VERSION } from "../core/constants.js";
import { loadConfig } from "../core/config.js";
import { CliError, ExitCode } from "../core/errors.js";
import { assertWorkspaceExists, ensureWorkspace } from "../core/workspace.js";
import { buildIndex } from "../index/querylight-indexer.js";
import { ingestSources } from "../ingest/ingest-service.js";
import { searchIndex } from "../query/search-service.js";
import { createContext } from "../query/context-builder.js";
import { diffWorkspace, renderChangeReport } from "../report/diff-service.js";
import { addSource, listSources, removeSource, updateSource } from "../sources/source-store.js";
import type { CommandResponse, CrawlConfig, Metadata, Source, SourceType } from "../types/models.js";
import { formatSearchResults, formatSourcesTable } from "./format.js";
import { listRuns } from "../core/runs.js";
import { readJsonl } from "../core/jsonl.js";
import { readLatestIndexMetadata } from "../index/index-store.js";

type IoCapture = {
  stdout: string[];
  stderr: string[];
};

const SOURCE_TYPES = new Set<SourceType>(["url", "website", "file", "directory", "markdown", "text"]);

function parseKeyValue(input: string): [string, string] {
  const idx = input.indexOf("=");
  if (idx <= 0) {
    throw new CliError(`invalid key=value pair: ${input}`, "INVALID_ARGUMENT", ExitCode.InvalidArguments);
  }
  return [input.slice(0, idx), input.slice(idx + 1)];
}

function normalizeMetadata(values: string[] = []): Metadata {
  return Object.fromEntries(values.map(parseKeyValue));
}

function response<T>(command: string, workspace: string, data?: T, error?: CommandResponse<T>["error"]): CommandResponse<T> {
  return {
    ok: !error,
    command,
    workspace,
    version: PACKAGE_VERSION,
    data,
    error
  };
}

function writeOutput(capture: IoCapture, value: string, stderr = false): void {
  (stderr ? capture.stderr : capture.stdout).push(value);
}

async function resolveWorkspace(options: { workspace?: string }): Promise<string> {
  return path.resolve(options.workspace ?? DEFAULT_WORKSPACE);
}

export async function runCli(argv: string[]): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const capture: IoCapture = { stdout: [], stderr: [] };
  const program = new Command();

  program
    .name("qli")
    .showHelpAfterError()
    .option("--workspace <path>", "Workspace path", DEFAULT_WORKSPACE)
    .option("--config <path>", "Config path")
    .option("--json", "JSON output")
    .option("--verbose", "Verbose output")
    .option("--quiet", "Quiet output");

  program.command("init")
    .option("--force")
    .action(async function command(options) {
      const workspace = await resolveWorkspace({ workspace: this.optsWithGlobals().workspace });
      const result = await ensureWorkspace({ workspacePath: workspace, force: Boolean(options.force) });
      emit(this.optsWithGlobals().json, capture, response("init", workspace, result), `Initialized workspace at ${workspace}`);
    });

  const source = program.command("source");
  source.command("add")
    .argument("<type>")
    .argument("<uri>")
    .requiredOption("--name <name>")
    .option("--tag <tag...>")
    .option("--metadata <key=value...>")
    .option("--max-depth <n>")
    .option("--max-pages <n>")
    .option("--include <pattern...>")
    .option("--exclude <pattern...>")
    .option("--render-js")
    .option("--no-robots")
    .option("--rate-limit-ms <n>")
    .action(async function command(type: SourceType, uri: string, options) {
      if (!SOURCE_TYPES.has(type)) {
        throw new CliError(`unsupported source type: ${type}`, "INVALID_ARGUMENT", ExitCode.InvalidArguments);
      }
      const global = this.optsWithGlobals();
      const workspace = await resolveWorkspace({ workspace: global.workspace });
      const now = new Date().toISOString();
      const crawl: CrawlConfig | undefined = ["url", "website", "directory"].includes(type)
        ? {
            maxDepth: options.maxDepth ? Number(options.maxDepth) : undefined,
            maxPages: options.maxPages ? Number(options.maxPages) : undefined,
            includePatterns: options.include,
            excludePatterns: options.exclude,
            obeyRobotsTxt: options.robots,
            rateLimitMs: options.rateLimitMs ? Number(options.rateLimitMs) : undefined,
            renderJs: Boolean(options.renderJs),
            useSitemap: true
          }
        : undefined;
      const stored = await addSource(workspace, {
        type,
        uri: ["file", "directory"].includes(type) ? path.resolve(uri) : uri,
        name: options.name,
        enabled: true,
        tags: options.tag ?? [],
        metadata: normalizeMetadata(options.metadata),
        crawl,
        createdAt: now,
        updatedAt: now
      });
      emit(global.json, capture, response("source add", workspace, stored), `Added source ${stored.id}`);
    });

  source.command("list").action(async function command() {
    const global = this.optsWithGlobals();
    const workspace = await resolveWorkspace({ workspace: global.workspace });
    const sources = await listSources(workspace);
    emit(global.json, capture, response("source list", workspace, sources), formatSourcesTable(sources));
  });

  source.command("remove").argument("<sourceId>").action(async function command(sourceId: string) {
    const global = this.optsWithGlobals();
    const workspace = await resolveWorkspace({ workspace: global.workspace });
    await removeSource(workspace, sourceId);
    emit(global.json, capture, response("source remove", workspace, { sourceId }), `Removed source ${sourceId}`);
  });

  source.command("disable").argument("<sourceId>").action(async function command(sourceId: string) {
    const global = this.optsWithGlobals();
    const workspace = await resolveWorkspace({ workspace: global.workspace });
    const updated = await updateSource(workspace, sourceId, { enabled: false, updatedAt: new Date().toISOString() });
    emit(global.json, capture, response("source disable", workspace, updated), `Disabled source ${sourceId}`);
  });

  source.command("enable").argument("<sourceId>").action(async function command(sourceId: string) {
    const global = this.optsWithGlobals();
    const workspace = await resolveWorkspace({ workspace: global.workspace });
    const updated = await updateSource(workspace, sourceId, { enabled: true, updatedAt: new Date().toISOString() });
    emit(global.json, capture, response("source enable", workspace, updated), `Enabled source ${sourceId}`);
  });

  program.command("ingest")
    .option("--source <sourceId>")
    .option("--changed-only")
    .action(async function command(options) {
      const global = this.optsWithGlobals();
      const workspace = await resolveWorkspace({ workspace: global.workspace });
      const result = await ingestSources({ workspacePath: workspace, sourceIds: options.source ? [options.source] : undefined, changedOnly: Boolean(options.changedOnly) });
      emit(global.json, capture, response("ingest", workspace, result), `Ingested ${result.processedSources} sources`);
    });

  program.command("chunk")
    .option("--source <sourceId>")
    .option("--document <documentId>")
    .action(async function command(options) {
      const global = this.optsWithGlobals();
      const workspace = await resolveWorkspace({ workspace: global.workspace });
      const result = await chunkDocuments({ workspacePath: workspace, sourceId: options.source, documentId: options.document });
      emit(global.json, capture, response("chunk", workspace, result), `Wrote ${result.chunksWritten} chunks`);
    });

  const index = program.command("index");
  index.command("build").action(async function command() {
    const global = this.optsWithGlobals();
    const workspace = await resolveWorkspace({ workspace: global.workspace });
    const result = await buildIndex({ workspacePath: workspace });
    emit(global.json, capture, response("index build", workspace, result), `Built index at ${result.indexPath}`);
  });

  program.command("rebuild")
    .option("--source <sourceId>")
    .option("--changed-only")
    .action(async function command(options) {
      const global = this.optsWithGlobals();
      const workspace = await resolveWorkspace({ workspace: global.workspace });
      const ingest = await ingestSources({ workspacePath: workspace, sourceIds: options.source ? [options.source] : undefined, changedOnly: Boolean(options.changedOnly) });
      const chunk = await chunkDocuments({ workspacePath: workspace, sourceId: options.source });
      const indexBuild = await buildIndex({ workspacePath: workspace });
      const data = { ingest, chunk, indexPath: indexBuild.indexPath, metadata: indexBuild.metadata };
      emit(global.json, capture, response("rebuild", workspace, data), `Processed ${ingest.processedSources} sources, wrote ${chunk.chunksWritten} chunks`);
    });

  program.command("search")
    .argument("<query>")
    .option("--top-k <n>", "", "12")
    .option("--source <sourceId>")
    .option("--tag <tag>")
    .option("--metadata <key=value...>")
    .option("--show-chunks")
    .action(async function command(query: string, options) {
      const global = this.optsWithGlobals();
      const workspace = await resolveWorkspace({ workspace: global.workspace });
      const result = await searchIndex({
        workspacePath: workspace,
        query,
        topK: Number(options.topK),
        sourceId: options.source,
        tag: options.tag,
        metadata: ((options.metadata ?? []) as string[]).map(parseKeyValue).map(([key, value]: [string, string]) => ({ key, value })),
        showChunks: Boolean(options.showChunks)
      });
      emit(global.json, capture, response("search", workspace, result), formatSearchResults(result.results));
    });

  program.command("context")
    .argument("<query>")
    .option("--top-k <n>", "", "12")
    .option("--max-chars <n>", "", "12000")
    .action(async function command(query: string, options) {
      const global = this.optsWithGlobals();
      const workspace = await resolveWorkspace({ workspace: global.workspace });
      const result = await createContext({ workspacePath: workspace, query, topK: Number(options.topK), maxChars: Number(options.maxChars) });
      emit(global.json, capture, response("context", workspace, result), result.markdown);
    });

  program.command("diff")
    .option("--source <sourceId>")
    .option("--document <documentId>")
    .option("--since <timestamp>")
    .action(async function command(options) {
      const global = this.optsWithGlobals();
      const workspace = await resolveWorkspace({ workspace: global.workspace });
      const result = await diffWorkspace({ workspacePath: workspace, sourceId: options.source, documentId: options.document, since: options.since });
      emit(global.json, capture, response("diff", workspace, result), JSON.stringify(result, null, 2));
    });

  const report = program.command("report");
  report.command("changes")
    .option("--source <sourceId>")
    .option("--since <timestamp>")
    .action(async function command(options) {
      const global = this.optsWithGlobals();
      const workspace = await resolveWorkspace({ workspace: global.workspace });
      const diff = await diffWorkspace({ workspacePath: workspace, sourceId: options.source, since: options.since });
      const markdown = renderChangeReport(diff);
      emit(global.json, capture, response("report changes", workspace, { markdown, diff }), markdown);
    });

  program.command("status").action(async function command() {
    const global = this.optsWithGlobals();
    const workspace = await resolveWorkspace({ workspace: global.workspace });
    const sources = await listSources(workspace);
    const documents = await readJsonl(`${workspace}/documents/documents.jsonl`);
    const chunks = await readJsonl(`${workspace}/chunks/chunks.jsonl`);
    const runs = await listRuns(workspace);
    let latestIndex: string | undefined;
    let indexSize = 0;
    try {
      const meta = await readLatestIndexMetadata(workspace);
      latestIndex = meta.createdAt;
      indexSize = (await stat(`${workspace}/indexes/latest.json`)).size;
    } catch {
      latestIndex = undefined;
    }
    const data = {
      workspace,
      sources: sources.length,
      documents: documents.length,
      chunks: chunks.length,
      latestIndex,
      indexSizeBytes: indexSize,
      lastRun: runs.at(-1)?.success ? "success" : runs.at(-1) ? "failed" : "none"
    };
    emit(global.json, capture, response("status", workspace, data), [
      `Workspace: ${workspace}`,
      `Sources: ${data.sources}`,
      `Documents: ${data.documents}`,
      `Chunks: ${data.chunks}`,
      `Latest index: ${data.latestIndex ?? "none"}`,
      `Index size: ${Math.round(indexSize / 1024)} KB`,
      `Last run: ${data.lastRun}`
    ].join("\n"));
  });

  program.command("doctor").action(async function command() {
    const global = this.optsWithGlobals();
    const workspace = await assertWorkspaceExists(await resolveWorkspace({ workspace: global.workspace }));
    const checks: string[] = [];
    await loadConfig(workspace, global.config);
    checks.push("workspace exists");
    checks.push("config parses");
    await listSources(workspace);
    checks.push("sources parse");
    await readJsonl(`${workspace}/documents/documents.jsonl`);
    checks.push("documents parse");
    await readJsonl(`${workspace}/chunks/chunks.jsonl`);
    checks.push("chunks parse");
    try {
      await readLatestIndexMetadata(workspace);
      checks.push("latest index exists");
    } catch {
      checks.push("latest index missing");
    }
    emit(global.json, capture, response("doctor", workspace, { checks }), checks.join("\n"));
  });

  let exitCode = 0;
  try {
    await program.parseAsync(["node", "qli", ...argv], { from: "node" });
  } catch (error) {
    const workspace = await resolveWorkspace({ workspace: DEFAULT_WORKSPACE });
    const cliError = error instanceof CliError
      ? error
      : new CliError((error as Error).message, "GENERAL_ERROR", ExitCode.GeneralError);
    writeOutput(capture, JSON.stringify(response("error", workspace, undefined, {
      code: cliError.code,
      message: cliError.message,
      details: cliError.details
    })), true);
    exitCode = cliError.exitCode;
  }
  return {
    exitCode,
    stdout: capture.stdout.join("\n"),
    stderr: capture.stderr.join("\n")
  };
}

function emit<T>(asJson: boolean, capture: IoCapture, body: CommandResponse<T>, human: string): void {
  writeOutput(capture, asJson ? JSON.stringify(body) : human);
}
