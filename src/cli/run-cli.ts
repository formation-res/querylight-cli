import { Command } from "commander";
import { stat } from "node:fs/promises";
import path from "node:path";
import { chunkDocuments } from "../chunk/chunker.js";
import { DEFAULT_WORKSPACE, PACKAGE_VERSION } from "../core/constants.js";
import { loadConfig } from "../core/config.js";
import { CliError, ExitCode } from "../core/errors.js";
import { assertWorkspaceExists, ensureWorkspace } from "../core/workspace.js";
import { buildIndex } from "../index/querylight-indexer.js";
import { ingestSources, reprocessDocuments } from "../ingest/ingest-service.js";
import { searchIndex } from "../query/search-service.js";
import { findRelatedDocuments } from "../query/related-service.js";
import { createContext } from "../query/context-builder.js";
import { diffWorkspace, renderChangeReport } from "../report/diff-service.js";
import { addSource, listSources, removeSource, updateSource } from "../sources/source-store.js";
import type { CommandResponse, CrawlConfig, Metadata, RetrievalMode, Source, SourceType } from "../types/models.js";
import { formatRelatedDocuments, formatSearchResults, formatSourcesTable } from "./format.js";
import { listRuns } from "../core/runs.js";
import { readJsonl } from "../core/jsonl.js";
import { readLatestIndexMetadata } from "../index/index-store.js";
import { getModelStatus, pullModels, resolveModelPullPlan } from "../vector/service.js";
import { ensureUvAvailable } from "../vector/runtime.js";

type IoCapture = {
  stdout: string[];
  stderr: string[];
};

const SOURCE_TYPES = new Set<SourceType>(["url", "website", "rss", "file", "directory", "markdown", "text"]);
const RETRIEVAL_MODES = new Set<RetrievalMode>(["lexical", "dense", "sparse", "hybrid"]);
const SOURCE_TYPE_LIST = ["url", "website", "rss", "file", "directory", "markdown", "text"] as const;
const RETRIEVAL_MODE_LIST = ["lexical", "dense", "sparse", "hybrid"] as const;

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

function parseRetrievalMode(input: string | undefined): RetrievalMode | undefined {
  if (!input) {
    return undefined;
  }
  if (!RETRIEVAL_MODES.has(input as RetrievalMode)) {
    throw new CliError(`unsupported retrieval mode: ${input}`, "INVALID_ARGUMENT", ExitCode.InvalidArguments);
  }
  return input as RetrievalMode;
}

async function resolveWorkspace(options: { workspace?: string }): Promise<string> {
  return path.resolve(options.workspace ?? DEFAULT_WORKSPACE);
}

function workspaceFromArgv(argv: string[]): string {
  const index = argv.findIndex((arg) => arg === "--workspace");
  if (index >= 0 && argv[index + 1]) {
    return path.resolve(argv[index + 1]!);
  }
  return path.resolve(DEFAULT_WORKSPACE);
}

export async function runCli(argv: string[]): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const capture: IoCapture = { stdout: [], stderr: [] };
  const program = new Command();

  program
    .name("qli")
    .description("Build and query a local Querylight workspace from files, directories, URLs, websites, and feeds.")
    .showHelpAfterError()
    .option("--workspace <path>", "Workspace directory. Defaults to .kb in the current directory.", DEFAULT_WORKSPACE)
    .option("--config <path>", "Optional config file override. Useful for testing alternate retrieval settings.")
    .option("--json", "Return a stable JSON envelope for automation and agents.")
    .option("--verbose", "Print more operational detail when a command supports it.")
    .option("--quiet", "Suppress non-essential human-readable output.");
  program.addHelpText("after", `
Workflow:
  1. Initialize a workspace with qli init
  2. Register one or more sources with qli source add
  3. Build or refresh the workspace with qli rebuild
  4. Query it with qli search, qli related, or qli context

Examples:
  qli init
  qli source add directory ./docs --name "Product Docs" --tag docs
  qli rebuild
  qli search "api authentication" --top-k 8
  qli context "How do API keys work?" --top-k 8 --max-chars 8000

Use qli <command> --help for command-specific options and examples.`);

  program.command("init")
    .description("Create a new workspace with the default directory layout and config.")
    .option("--force")
    .addHelpText("after", `
Examples:
  qli init
  qli init --workspace ./kb
  qli init --workspace /tmp/querylight --force`)
    .action(async function command(options) {
      const workspace = await resolveWorkspace({ workspace: this.optsWithGlobals().workspace });
      const result = await ensureWorkspace({ workspacePath: workspace, force: Boolean(options.force) });
      emit(this.optsWithGlobals().json, capture, response("init", workspace, result), `Initialized workspace at ${workspace}`);
    });

  const source = program.command("source");
  source
    .description("Register, inspect, and manage workspace sources.");
  source.command("add")
    .description("Add a source definition. The source is enabled immediately.")
    .argument("<type>", `Source type: ${SOURCE_TYPE_LIST.join(", ")}`)
    .argument("<uri>", "Local path, URL, feed URL, or inline content depending on the source type.")
    .requiredOption("--name <name>")
    .option("--tag <tag...>", "Optional tags used later for filtering during search.")
    .option("--metadata <key=value...>", "Extra metadata fields stored on the source.")
    .option("--max-depth <n>", "Maximum crawl depth for website, URL, directory, and RSS sources.")
    .option("--max-pages <n>", "Maximum number of pages or files to ingest from a crawlable source.")
    .option("--include <pattern...>", "Only include matching paths or URLs.")
    .option("--exclude <pattern...>", "Skip matching paths or URLs.")
    .option("--render-js", "Render pages with JavaScript before extraction when supported.")
    .option("--no-robots", "Ignore robots.txt. Use only when you control the target site or have permission.")
    .option("--rate-limit-ms <n>", "Delay between requests for crawlable sources.")
    .option("--retention-days <n>", "Retention window for feed or crawl snapshots.")
    .addHelpText("after", `
Examples:
  qli source add directory ./docs --name "Local Docs" --tag docs
  qli source add file ./docs/auth.md --name "Auth Guide"
  qli source add url https://example.com/docs/auth --name "Auth Page"
  qli source add website https://example.com --name "Docs Site" --max-depth 2 --max-pages 50 --include /docs/
  qli source add rss https://example.com/feed.xml --name "Release Feed" --retention-days 30`)
    .action(async function command(type: SourceType, uri: string, options) {
      if (!SOURCE_TYPES.has(type)) {
        throw new CliError(`unsupported source type: ${type}`, "INVALID_ARGUMENT", ExitCode.InvalidArguments);
      }
      const global = this.optsWithGlobals();
      const workspace = await resolveWorkspace({ workspace: global.workspace });
      const now = new Date().toISOString();
      const crawl: CrawlConfig | undefined = ["url", "website", "directory", "rss"].includes(type)
        ? {
            maxDepth: options.maxDepth ? Number(options.maxDepth) : undefined,
            maxPages: options.maxPages ? Number(options.maxPages) : undefined,
            includePatterns: options.include,
            excludePatterns: options.exclude,
            obeyRobotsTxt: options.robots,
            rateLimitMs: options.rateLimitMs ? Number(options.rateLimitMs) : undefined,
            renderJs: Boolean(options.renderJs),
            useSitemap: type === "website" ? true : undefined,
            retentionDays: options.retentionDays ? Number(options.retentionDays) : undefined,
            fetchArticles: type === "rss" ? true : undefined
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

  source.command("list")
    .description("List all configured sources in the workspace.")
    .addHelpText("after", `
Examples:
  qli source list
  qli source list --json`)
    .action(async function command() {
    const global = this.optsWithGlobals();
    const workspace = await resolveWorkspace({ workspace: global.workspace });
    const sources = await listSources(workspace);
    emit(global.json, capture, response("source list", workspace, sources), formatSourcesTable(sources));
  });

  source.command("remove")
    .description("Delete a source definition from the workspace.")
    .argument("<sourceId>", "Source id from qli source list.")
    .addHelpText("after", `
Examples:
  qli source remove src_123
  qli source list --json`)
    .action(async function command(sourceId: string) {
    const global = this.optsWithGlobals();
    const workspace = await resolveWorkspace({ workspace: global.workspace });
    await removeSource(workspace, sourceId);
    emit(global.json, capture, response("source remove", workspace, { sourceId }), `Removed source ${sourceId}`);
  });

  source.command("disable")
    .description("Disable a source without removing its configuration.")
    .argument("<sourceId>", "Source id from qli source list.")
    .addHelpText("after", `
Examples:
  qli source disable src_123
  qli source enable src_123`)
    .action(async function command(sourceId: string) {
    const global = this.optsWithGlobals();
    const workspace = await resolveWorkspace({ workspace: global.workspace });
    const updated = await updateSource(workspace, sourceId, { enabled: false, updatedAt: new Date().toISOString() });
    emit(global.json, capture, response("source disable", workspace, updated), `Disabled source ${sourceId}`);
  });

  source.command("enable")
    .description("Re-enable a disabled source.")
    .argument("<sourceId>", "Source id from qli source list.")
    .addHelpText("after", `
Examples:
  qli source enable src_123
  qli source list`)
    .action(async function command(sourceId: string) {
    const global = this.optsWithGlobals();
    const workspace = await resolveWorkspace({ workspace: global.workspace });
    const updated = await updateSource(workspace, sourceId, { enabled: true, updatedAt: new Date().toISOString() });
    emit(global.json, capture, response("source enable", workspace, updated), `Enabled source ${sourceId}`);
  });

  program.command("ingest")
    .description("Fetch and normalize source content into workspace documents.")
    .option("--source <sourceId>", "Only ingest one source.")
    .option("--changed-only", "Skip content that has not changed since the last run.")
    .addHelpText("after", `
Examples:
  qli ingest
  qli ingest --source src_123
  qli ingest --changed-only`)
    .action(async function command(options) {
      const global = this.optsWithGlobals();
      const workspace = await resolveWorkspace({ workspace: global.workspace });
      const result = await ingestSources({ workspacePath: workspace, sourceIds: options.source ? [options.source] : undefined, changedOnly: Boolean(options.changedOnly) });
      emit(global.json, capture, response("ingest", workspace, result), `Ingested ${result.processedSources} sources`);
    });

  program.command("chunk")
    .description("Split normalized documents into retrieval chunks.")
    .option("--source <sourceId>", "Only chunk documents from one source.")
    .option("--document <documentId>", "Only chunk one document.")
    .addHelpText("after", `
Examples:
  qli chunk
  qli chunk --source src_123
  qli chunk --document doc_123`)
    .action(async function command(options) {
      const global = this.optsWithGlobals();
      const workspace = await resolveWorkspace({ workspace: global.workspace });
      const result = await chunkDocuments({ workspacePath: workspace, sourceId: options.source, documentId: options.document });
      emit(global.json, capture, response("chunk", workspace, result), `Wrote ${result.chunksWritten} chunks`);
    });

  program.command("reprocess")
    .description("Re-run normalization for existing documents without fetching sources again.")
    .option("--source <sourceId>", "Only reprocess documents from one source.")
    .option("--document <documentId>", "Only reprocess one document.")
    .addHelpText("after", `
Examples:
  qli reprocess
  qli reprocess --source src_123
  qli reprocess --document doc_123`)
    .action(async function command(options) {
      const global = this.optsWithGlobals();
      const workspace = await resolveWorkspace({ workspace: global.workspace });
      const result = await reprocessDocuments({ workspacePath: workspace, sourceId: options.source, documentId: options.document });
      emit(global.json, capture, response("reprocess", workspace, result), `Reprocessed ${result.documentsReprocessed} documents`);
    });

  const index = program.command("index");
  index.description("Build and inspect retrieval indexes.");
  index.command("build")
    .description("Build lexical search artifacts and optional dense or sparse vector indexes.")
    .option("--dense", "Force a dense vector build if the dense model is available.")
    .option("--sparse", "Force a sparse vector build if the sparse runtime is available.")
    .addHelpText("after", `
Examples:
  qli index build
  qli index build --dense
  qli index build --dense --sparse`)
    .action(async function command(options) {
    const global = this.optsWithGlobals();
    const workspace = await resolveWorkspace({ workspace: global.workspace });
    const result = await buildIndex({
      workspacePath: workspace,
      denseOverride: options.dense ? true : undefined,
      sparseOverride: options.sparse ? true : undefined
    });
    emit(global.json, capture, response("index build", workspace, result), `Built index at ${result.indexPath}`);
  });

  program.command("rebuild")
    .description("Run ingest, chunk, and index build in one command.")
    .option("--source <sourceId>", "Only rebuild data for one source.")
    .option("--changed-only", "Only ingest changed content before chunking and indexing.")
    .option("--dense", "Force a dense vector build if the dense model is available.")
    .option("--sparse", "Force a sparse vector build if the sparse runtime is available.")
    .addHelpText("after", `
Examples:
  qli rebuild
  qli rebuild --changed-only
  qli rebuild --source src_123
  qli rebuild --dense --sparse`)
    .action(async function command(options) {
      const global = this.optsWithGlobals();
      const workspace = await resolveWorkspace({ workspace: global.workspace });
      const ingest = await ingestSources({ workspacePath: workspace, sourceIds: options.source ? [options.source] : undefined, changedOnly: Boolean(options.changedOnly) });
      const chunk = await chunkDocuments({ workspacePath: workspace, sourceId: options.source });
      const indexBuild = await buildIndex({
        workspacePath: workspace,
        denseOverride: options.dense ? true : undefined,
        sparseOverride: options.sparse ? true : undefined,
        buildAvailableModels: true
      });
      const data = { ingest, chunk, indexPath: indexBuild.indexPath, metadata: indexBuild.metadata };
      emit(global.json, capture, response("rebuild", workspace, data), `Processed ${ingest.processedSources} sources, wrote ${chunk.chunksWritten} chunks`);
    });

  program.command("search")
    .description("Search the built index and return ranked matching documents or chunks.")
    .argument("<query>")
    .option("--top-k <n>", "Maximum number of results to return.", "12")
    .option("--source <sourceId>", "Restrict results to one source.")
    .option("--tag <tag>", "Restrict results to sources carrying a specific tag.")
    .option("--metadata <key=value...>", "Restrict results to sources with matching metadata.")
    .option("--retrieval <mode>", `Retrieval mode: ${RETRIEVAL_MODE_LIST.join(", ")}`)
    .option("--show-chunks", "Return chunk-level matches when available.")
    .addHelpText("after", `
Examples:
  qli search "pricing api limits"
  qli search "authentication" --top-k 20 --tag docs
  qli search "billing" --metadata team=support
  qli search "embedding model" --retrieval hybrid --show-chunks

Notes:
  lexical works without vector models.
  dense, sparse, and hybrid require the relevant index artifacts to exist.`)
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
        retrievalMode: parseRetrievalMode(options.retrieval),
        showChunks: Boolean(options.showChunks)
      });
      emit(global.json, capture, response("search", workspace, result), formatSearchResults(result.results));
    });

  program.command("related")
    .description("Find documents similar to an existing document by id or URI.")
    .argument("<document>", "Document id, uri, or canonical uri")
    .option("--top-k <n>", "Maximum number of related documents to return.", "12")
    .addHelpText("after", `
Examples:
  qli related doc_123
  qli related https://example.com/docs/auth

Dense vectors usually produce better related-document results. Pull models and rebuild first when needed:
  qli models pull --dense
  qli rebuild --dense`)
    .action(async function command(document: string, options) {
      const global = this.optsWithGlobals();
      const workspace = await resolveWorkspace({ workspace: global.workspace });
      const result = await findRelatedDocuments({
        workspacePath: workspace,
        document,
        topK: Number(options.topK)
      });
      emit(global.json, capture, response("related", workspace, result), formatRelatedDocuments(result.results));
    });

  program.command("context")
    .description("Assemble retrieval context for an external LLM, agent, or prompt pipeline.")
    .argument("<query>")
    .option("--top-k <n>", "Maximum number of source passages to consider.", "12")
    .option("--max-chars <n>", "Maximum output length for the rendered context block.", "12000")
    .option("--retrieval <mode>", `Retrieval mode: ${RETRIEVAL_MODE_LIST.join(", ")}`)
    .addHelpText("after", `
Examples:
  qli context "How do I configure the API?"
  qli context "What changed in pricing?" --top-k 10 --max-chars 9000
  qli context "How does auth work?" --retrieval hybrid

Use --json when another tool needs structured access to the raw passages and metadata.`)
    .action(async function command(query: string, options) {
      const global = this.optsWithGlobals();
      const workspace = await resolveWorkspace({ workspace: global.workspace });
      const result = await createContext({
        workspacePath: workspace,
        query,
        topK: Number(options.topK),
        maxChars: Number(options.maxChars),
        retrievalMode: parseRetrievalMode(options.retrieval)
      });
      emit(global.json, capture, response("context", workspace, result), result.markdown);
    });

  const models = program.command("models");
  models.description("Inspect and download retrieval model assets.");
  models.command("pull")
    .description("Download dense and or sparse retrieval assets required by vector search.")
    .option("--dense", "Only pull dense retrieval assets.")
    .option("--sparse", "Only pull sparse retrieval assets.")
    .addHelpText("after", `
Examples:
  qli models pull
  qli models pull --dense
  qli models pull --sparse

If you plan to use related, dense search, or hybrid retrieval, pull the models and rebuild the index first.`)
    .action(async function command(options) {
      const global = this.optsWithGlobals();
      const workspace = await resolveWorkspace({ workspace: global.workspace });
      const config = await loadConfig(workspace, global.config);
      const status = await getModelStatus(workspace, config);
      const { pullDense, pullSparse } = resolveModelPullPlan({
        pullDenseFlag: Boolean(options.dense),
        pullSparseFlag: Boolean(options.sparse),
        uvAvailable: status.sparse.uvAvailable
      });
      await pullModels({ workspacePath: workspace, config, pullDense, pullSparse });
      const data = {
        dense: pullDense ? { pulled: true, modelId: config.retrieval.dense.modelId, cacheDir: config.retrieval.dense.cacheDir } : undefined,
        sparse: pullSparse ? { pulled: true, modelId: config.retrieval.sparse.modelId, cacheDir: config.retrieval.sparse.cacheDir } : undefined
      };
      emit(global.json, capture, response("models pull", workspace, data), "Pulled available models");
    });

  models.command("status")
    .description("Show whether model runtimes and artifacts are available in the workspace.")
    .addHelpText("after", `
Examples:
  qli models status
  qli models status --json`)
    .action(async function command() {
    const global = this.optsWithGlobals();
    const workspace = await resolveWorkspace({ workspace: global.workspace });
    const config = await loadConfig(workspace, global.config);
    const data = await getModelStatus(workspace, config);
    emit(global.json, capture, response("models status", workspace, data), JSON.stringify(data, null, 2));
  });

  program.command("diff")
    .description("Inspect document-level changes between stored workspace versions.")
    .option("--source <sourceId>", "Only inspect changes for one source.")
    .option("--document <documentId>", "Only inspect one document.")
    .option("--since <timestamp>", "Only include changes since an ISO timestamp.")
    .addHelpText("after", `
Examples:
  qli diff
  qli diff --source src_123
  qli diff --document doc_123
  qli diff --since 2026-05-01`)
    .action(async function command(options) {
      const global = this.optsWithGlobals();
      const workspace = await resolveWorkspace({ workspace: global.workspace });
      const result = await diffWorkspace({ workspacePath: workspace, sourceId: options.source, documentId: options.document, since: options.since });
      emit(global.json, capture, response("diff", workspace, result), JSON.stringify(result, null, 2));
    });

  const report = program.command("report");
  report.description("Render higher-level reports from workspace data.");
  report.command("changes")
    .description("Render a markdown change report from workspace diffs.")
    .option("--source <sourceId>", "Only include one source.")
    .option("--since <timestamp>", "Only include changes since an ISO timestamp.")
    .addHelpText("after", `
Examples:
  qli report changes
  qli report changes --since 2026-05-01
  qli report changes --source src_123 --json`)
    .action(async function command(options) {
      const global = this.optsWithGlobals();
      const workspace = await resolveWorkspace({ workspace: global.workspace });
      const diff = await diffWorkspace({ workspacePath: workspace, sourceId: options.source, since: options.since });
      const markdown = renderChangeReport(diff);
      emit(global.json, capture, response("report changes", workspace, { markdown, diff }), markdown);
    });

  program.command("status")
    .description("Summarize workspace size, index state, and model artifact availability.")
    .addHelpText("after", `
Examples:
  qli status
  qli status --json`)
    .action(async function command() {
    const global = this.optsWithGlobals();
    const workspace = await resolveWorkspace({ workspace: global.workspace });
    const sources = await listSources(workspace);
    const documents = await readJsonl(`${workspace}/documents/documents.jsonl`);
    const chunks = await readJsonl(`${workspace}/chunks/chunks.jsonl`);
    const runs = await listRuns(workspace);
    const config = await loadConfig(workspace, global.config);
    const modelStatus = await getModelStatus(workspace, config);
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
      lastRun: runs.at(-1)?.success ? "success" : runs.at(-1) ? "failed" : "none",
      denseVectorIndex: modelStatus.dense.artifactExists,
      sparseVectorIndex: modelStatus.sparse.artifactExists
    };
    emit(global.json, capture, response("status", workspace, data), [
      `Workspace: ${workspace}`,
      `Sources: ${data.sources}`,
      `Documents: ${data.documents}`,
      `Chunks: ${data.chunks}`,
      `Latest index: ${data.latestIndex ?? "none"}`,
      `Index size: ${Math.round(indexSize / 1024)} KB`,
      `Last run: ${data.lastRun}`,
      `Dense vector index: ${data.denseVectorIndex}`,
      `Sparse vector index: ${data.sparseVectorIndex}`
    ].join("\n"));
  });

  program.command("doctor")
    .description("Run basic workspace and runtime checks.")
    .addHelpText("after", `
Examples:
  qli doctor
  qli doctor --json`)
    .action(async function command() {
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
    const config = await loadConfig(workspace, global.config);
    if (config.retrieval.dense.enabled) {
      await import("@huggingface/transformers");
      checks.push("dense runtime importable");
    }
    if (config.retrieval.sparse.enabled) {
      await ensureUvAvailable();
      checks.push("uv available for sparse runtime");
    }
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
    const workspace = workspaceFromArgv(argv);
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
