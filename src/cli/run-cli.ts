import { Command, Option } from "commander";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { chunkDocuments } from "../chunk/chunker.js";
import { DEFAULT_WORKSPACE, PACKAGE_VERSION } from "../core/constants.js";
import { loadConfig } from "../core/config.js";
import { CliError, ExitCode } from "../core/errors.js";
import { assertWorkspaceExists, ensureWorkspace } from "../core/workspace.js";
import { buildIndex } from "../index/querylight-indexer.js";
import { ingestSources, reprocessDocuments } from "../ingest/ingest-service.js";
import { discoverWebsiteFeed, type WebsiteFeedDiscovery } from "../ingest/adapters/website-feed-discovery.js";
import { searchIndex, searchJsonIndex } from "../query/search-service.js";
import { findRelatedDocuments } from "../query/related-service.js";
import { createContext } from "../query/context-builder.js";
import { diffWorkspace, renderChangeReport } from "../report/diff-service.js";
import { addSource, listSources, removeSource, updateSource } from "../sources/source-store.js";
import type { CommandResponse, CrawlConfig, Metadata, RetrievalMode, Source, SourceType } from "../types/models.js";
import { formatRelatedDocuments, formatSearchResults, formatSourcesTable } from "./format.js";
import { listRuns } from "../core/runs.js";
import { readJsonl } from "../core/jsonl.js";
import { readLatestIndexMetadata, resolveLatestIndexArtifactPath } from "../index/index-store.js";
import { getModelStatus, pullModels, resolveMissingConfiguredModelPullPlan, resolveModelPullPlan } from "../vector/service.js";
import { ensureUvAvailable, isUvAvailable, resolveCacheDir } from "../vector/runtime.js";
import type { ProgressHandler, ProgressLevel } from "../core/progress.js";

type IoCapture = {
  stdout: string[];
  stderr: string[];
  onStdout?: (value: string) => void;
  onStderr?: (value: string) => void;
};

type GlobalCliOptions = {
  workspace?: string;
  config?: string;
  json?: boolean;
  verbose?: boolean;
  quiet?: boolean;
  silent?: boolean;
};

const SOURCE_TYPES = new Set<SourceType>(["url", "website", "rss", "file", "directory", "markdown", "text"]);
const RETRIEVAL_MODES = new Set<RetrievalMode>(["lexical", "dense", "sparse", "hybrid"]);
const SOURCE_TYPE_LIST = ["page", "website", "rss", "file", "directory", "markdown", "text"] as const;
const RETRIEVAL_MODE_LIST = ["lexical", "dense", "sparse", "hybrid"] as const;
const SEARCH_DATE_FIELDS = ["publicationDate", "firstSeenAt", "lastSeenAt", "lastChangedAt", "crawledAt"] as const;

type SearchDateField = typeof SEARCH_DATE_FIELDS[number];
type SourceConfigOptions = {
  name?: string;
  tag?: string[];
  metadata?: string[];
  maxDepth?: string;
  maxPages?: string;
  maxConcurrentRequests?: string;
  include?: string[];
  exclude?: string[];
  retentionDays?: string;
};

type WebsiteSourceAddResult = {
  primarySource: Source;
  addedSources: Source[];
  detectedFeed: {
    url: string;
    discoveredBy: WebsiteFeedDiscovery["discoveredBy"];
    excludePrefix?: string;
    source?: Source;
    wasAdded: boolean;
  } | null;
};

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

function parseOptionalNumber(input: string | undefined, optionName: string): number | undefined {
  if (input === undefined) {
    return undefined;
  }
  const value = Number(input);
  if (!Number.isFinite(value)) {
    throw new CliError(`invalid number for ${optionName}: ${input}`, "INVALID_ARGUMENT", ExitCode.InvalidArguments);
  }
  return value;
}

function parseOptionalPositiveInteger(input: string | undefined, optionName: string): number | undefined {
  const value = parseOptionalNumber(input, optionName);
  if (value === undefined) {
    return undefined;
  }
  if (!Number.isInteger(value) || value < 1) {
    throw new CliError(`invalid positive integer for ${optionName}: ${input}`, "INVALID_ARGUMENT", ExitCode.InvalidArguments);
  }
  return value;
}

function setWhenDefined<T extends object, K extends keyof T>(target: T, key: K, value: T[K] | undefined): void {
  if (value !== undefined) {
    target[key] = value;
  }
}

function mergePatterns(existing: string[] | undefined, extra: string | undefined): string[] | undefined {
  const merged = [...(existing ?? [])];
  if (extra && !merged.includes(extra)) {
    merged.push(extra);
  }
  return merged.length > 0 ? merged : undefined;
}

function formatWebsiteSourceAdd(result: WebsiteSourceAddResult): string {
  const lines = [`Added source ${result.primarySource.id}`];
  if (!result.detectedFeed) {
    lines.push("No feed detected during website registration.");
    return lines.join("\n");
  }
  if (result.detectedFeed.source && result.detectedFeed.wasAdded) {
    lines.push(`Detected feed ${result.detectedFeed.url} and added source ${result.detectedFeed.source.id}.`);
  } else if (result.detectedFeed.source) {
    lines.push(`Detected feed ${result.detectedFeed.url}. Source ${result.detectedFeed.source.id} already exists.`);
  } else {
    lines.push(`Detected feed ${result.detectedFeed.url}.`);
  }
  if (result.detectedFeed.excludePrefix) {
    lines.push(`Excluded ${result.detectedFeed.excludePrefix} from the website crawl.`);
  }
  return lines.join("\n");
}

function createSourceCrawlConfig(type: SourceType, options: Record<string, unknown>, defaults: { retentionDays: number }): CrawlConfig | undefined {
  if (!["url", "website", "directory", "rss"].includes(type)) {
    return undefined;
  }
  const crawl: CrawlConfig = {};
  setWhenDefined(crawl, "maxDepth", parseOptionalNumber(options.maxDepth as string | undefined, "--max-depth"));
  setWhenDefined(crawl, "maxPages", parseOptionalNumber(options.maxPages as string | undefined, "--max-pages"));
  setWhenDefined(crawl, "maxConcurrentRequests", parseOptionalPositiveInteger(options.maxConcurrentRequests as string | undefined, "--max-concurrent-requests"));
  setWhenDefined(crawl, "includePatterns", options.include as string[] | undefined);
  setWhenDefined(crawl, "excludePatterns", options.exclude as string[] | undefined);
  setWhenDefined(crawl, "obeyRobotsTxt", options.robots as boolean | undefined);
  setWhenDefined(crawl, "rateLimitMs", parseOptionalNumber(options.rateLimitMs as string | undefined, "--rate-limit-ms"));
  if (options.renderJs) {
    crawl.renderJs = true;
  }
  if (type === "website") {
    crawl.useSitemap = true;
  }
  if (type === "rss") {
    crawl.retentionDays = parseOptionalNumber(options.retentionDays as string | undefined, "--retention-days") ?? defaults.retentionDays;
    crawl.fetchArticles = true;
  } else {
    setWhenDefined(crawl, "retentionDays", parseOptionalNumber(options.retentionDays as string | undefined, "--retention-days"));
  }
  return Object.keys(crawl).length > 0 ? crawl : undefined;
}

function validateSourceAddOptions(type: SourceType, options: Record<string, unknown>): void {
  const reject = (optionName: string): never => {
    throw new CliError(`${optionName} is not supported for source type ${type}`, "INVALID_ARGUMENT", ExitCode.InvalidArguments);
  };

  if (options.maxDepth !== undefined && type !== "website") {
    reject("--max-depth");
  }
  if (options.maxPages !== undefined && type !== "website") {
    reject("--max-pages");
  }
  if (options.maxConcurrentRequests !== undefined && !["website", "rss"].includes(type)) {
    reject("--max-concurrent-requests");
  }
  if (options.renderJs && type !== "website") {
    reject("--render-js");
  }
  if (options.robots === false && type !== "website") {
    reject("--no-robots");
  }
  if (options.rateLimitMs !== undefined && type !== "website") {
    reject("--rate-limit-ms");
  }
  if (options.include !== undefined && !["website", "directory"].includes(type)) {
    reject("--include");
  }
  if (options.exclude !== undefined && !["website", "directory"].includes(type)) {
    reject("--exclude");
  }
  if (options.retentionDays !== undefined && type !== "rss") {
    reject("--retention-days");
  }
}

function allowedSourceConfigFields(source: Source): Set<string> {
  const fields = new Set<string>(["name", "tag", "metadata"]);
  if (source.type === "rss") {
    fields.add("retentionDays");
    fields.add("maxConcurrentRequests");
  }
  if (source.type === "website") {
    fields.add("maxDepth");
    fields.add("maxPages");
    fields.add("maxConcurrentRequests");
    fields.add("include");
    fields.add("exclude");
  }
  if (source.type === "directory") {
    fields.add("include");
    fields.add("exclude");
  }
  return fields;
}

function buildSourceConfigPatch(source: Source, options: SourceConfigOptions): Partial<Source> {
  const allowed = allowedSourceConfigFields(source);
  const patch: Partial<Source> = {};
  if (options.name !== undefined) {
    patch.name = options.name;
  }
  if (options.tag !== undefined) {
    patch.tags = options.tag;
  }
  if (options.metadata !== undefined) {
    patch.metadata = normalizeMetadata(options.metadata);
  }

  const crawlPatch: CrawlConfig = {};
  const checkAllowed = (field: string, optionName: string): void => {
    if (!allowed.has(field)) {
      throw new CliError(`${optionName} is not supported for source type ${source.type}`, "INVALID_ARGUMENT", ExitCode.InvalidArguments);
    }
  };

  if (options.maxDepth !== undefined) {
    checkAllowed("maxDepth", "--max-depth");
    crawlPatch.maxDepth = parseOptionalNumber(options.maxDepth, "--max-depth");
  }
  if (options.maxPages !== undefined) {
    checkAllowed("maxPages", "--max-pages");
    crawlPatch.maxPages = parseOptionalNumber(options.maxPages, "--max-pages");
  }
  if (options.maxConcurrentRequests !== undefined) {
    checkAllowed("maxConcurrentRequests", "--max-concurrent-requests");
    crawlPatch.maxConcurrentRequests = parseOptionalPositiveInteger(options.maxConcurrentRequests, "--max-concurrent-requests");
  }
  if (options.include !== undefined) {
    checkAllowed("include", "--include");
    crawlPatch.includePatterns = options.include;
  }
  if (options.exclude !== undefined) {
    checkAllowed("exclude", "--exclude");
    crawlPatch.excludePatterns = options.exclude;
  }
  if (options.retentionDays !== undefined) {
    checkAllowed("retentionDays", "--retention-days");
    crawlPatch.retentionDays = parseOptionalNumber(options.retentionDays, "--retention-days");
  }
  if (Object.keys(crawlPatch).length > 0) {
    patch.crawl = crawlPatch;
  }
  return patch;
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
  if (stderr) {
    capture.onStderr?.(value);
    return;
  }
  capture.onStdout?.(value);
}

function createProgressHandler(capture: IoCapture, options: GlobalCliOptions): ProgressHandler | undefined {
  if (options.json || options.silent || options.quiet) {
    return undefined;
  }
  return (level: ProgressLevel, message: string) => {
    if (level === "detail" && !options.verbose) {
      return;
    }
    writeOutput(capture, message, true);
  };
}

async function runIngestCommand(
  {
    workspace,
    sourceId,
    changedOnly,
    dense,
    sparse,
    progress
  }: {
    workspace: string;
    sourceId?: string;
    changedOnly: boolean;
    dense?: boolean;
    sparse?: boolean;
    progress?: ProgressHandler;
  }
): Promise<{
  ingest: Awaited<ReturnType<typeof ingestSources>>;
  chunk: Awaited<ReturnType<typeof chunkDocuments>>;
  indexPath: string;
  metadata: Awaited<ReturnType<typeof buildIndex>>["metadata"];
}> {
  progress?.("info", "Ingest step 1/3: fetch and normalize");
  const ingest = await ingestSources({
    workspacePath: workspace,
    sourceIds: sourceId ? [sourceId] : undefined,
    changedOnly,
    progress
  });
  progress?.("info", "Ingest step 2/3: chunk affected documents");
  const chunk = await chunkDocuments({ workspacePath: workspace, sourceId, progress });
  progress?.("info", "Ingest step 3/3: refresh index");
  const indexBuild = await buildIndex({
    workspacePath: workspace,
    denseOverride: dense ? true : undefined,
    sparseOverride: sparse ? true : undefined,
    buildAvailableModels: true,
    progress
  });
  progress?.("info", "Ingest complete");
  return { ingest, chunk, indexPath: indexBuild.indexPath, metadata: indexBuild.metadata };
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

function parseSourceType(input: string | undefined): SourceType | undefined {
  if (!input) {
    return undefined;
  }
  const normalized = input === "page" ? "url" : input;
  if (!SOURCE_TYPES.has(normalized as SourceType)) {
    throw new CliError(`unsupported source type: ${input}`, "INVALID_ARGUMENT", ExitCode.InvalidArguments);
  }
  return normalized as SourceType;
}

function parseCommaSeparatedList(input: string | undefined): string[] | undefined {
  const values = (input ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  return values.length > 0 ? values : undefined;
}

function parseSourceTypes(input: string | undefined): SourceType[] | undefined {
  const values = parseCommaSeparatedList(input);
  if (!values) {
    return undefined;
  }
  return values.map((value) => parseSourceType(value) as SourceType);
}

function parseDateValue(input: string, optionName: string): string {
  const parsed = new Date(input);
  if (Number.isNaN(parsed.getTime())) {
    throw new CliError(`invalid date for ${optionName}: ${input}`, "INVALID_ARGUMENT", ExitCode.InvalidArguments);
  }
  return parsed.toISOString();
}

async function parseJsonArgument(input: string): Promise<Record<string, unknown>> {
  const raw = input.startsWith("@")
    ? await readFile(path.resolve(input.slice(1)), "utf8")
    : input;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("expected a JSON object");
    }
    return parsed as Record<string, unknown>;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new CliError(`invalid JSON request: ${message}`, "INVALID_ARGUMENT", ExitCode.InvalidArguments);
  }
}

function searchDateRanges(options: Record<string, string | undefined>): Array<{ field: SearchDateField; from?: string; to?: string }> {
  const entries: Array<{ field: SearchDateField; from?: string; to?: string }> = [];
  if (options.since || options.until) {
    entries.push({
      field: "publicationDate",
      from: options.since ? parseDateValue(options.since, "--since") : undefined,
      to: options.until ? parseDateValue(options.until, "--until") : undefined
    });
  }
  if (options.changedSince) {
    entries.push({
      field: "lastChangedAt",
      from: parseDateValue(options.changedSince, "--changed-since")
    });
  }
  for (const field of SEARCH_DATE_FIELDS) {
    const fromKey = `${field}From`;
    const toKey = `${field}To`;
    const from = options[fromKey];
    const to = options[toKey];
    if (!from && !to) {
      continue;
    }
    entries.push({
      field,
      from: from ? parseDateValue(from, `--${field}-from`) : undefined,
      to: to ? parseDateValue(to, `--${field}-to`) : undefined
    });
  }
  return entries;
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

export async function runCli(
  argv: string[],
  io: {
    onStdout?: (value: string) => void;
    onStderr?: (value: string) => void;
  } = {}
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const capture: IoCapture = { stdout: [], stderr: [], ...io };
  const program = new Command();

  program
    .name("qli")
    .description("Build and query a local Querylight workspace from files, directories, URLs, websites, and feeds.")
    .showHelpAfterError()
    .option("--workspace <path>", "Workspace directory. Defaults to .kb in the current directory.", DEFAULT_WORKSPACE)
    .option("--config <path>", "Optional config file override. Useful for testing alternate retrieval settings.")
    .option("--json", "Return a stable JSON envelope for automation and agents.")
    .option("--silent", "Suppress progress logging for long-running commands.")
    .option("--verbose", "Print more operational detail when a command supports it.")
    .addOption(new Option("--quiet", "Deprecated alias for --silent.").hideHelp());
  program.addHelpText("after", `
Workflow:
  1. Initialize a workspace with qli init
  2. Register one or more sources with qli source add
  3. Refresh the workspace with qli ingest
  4. Query it with qli search, qli related, or qli context

Examples:
  qli init
  qli source add directory ./docs --name "Product Docs" --tag docs
  qli ingest
  qli rebuild --silent
  qli search "api authentication" --top-k 8
  qli context "How do API keys work?" --top-k 8 --max-chars 8000

Long-running commands print progress to stderr by default. Use --silent to suppress it.
Use --json when another tool needs stable structured output.

Use qli <command> --help for command-specific options and examples.`);

  program.command("init")
    .description("Create a new workspace with the default directory layout and config, then pull missing retrieval models.")
    .option("--force")
    .addHelpText("after", `
Examples:
  qli init
  qli init --workspace ./kb
  qli init --workspace /tmp/querylight --force

Notes:
  init enables dense and sparse retrieval in new workspaces.
  init pulls missing model assets for enabled retrieval modes.
  Sparse model downloads require uv. If uv is not available, init skips the sparse pull.`)
    .action(async function command(options) {
      const global = this.optsWithGlobals();
      const workspace = await resolveWorkspace({ workspace: this.optsWithGlobals().workspace });
      const result = await ensureWorkspace({ workspacePath: workspace, force: Boolean(options.force) });
      const config = await loadConfig(workspace, global.config);
      const status = await getModelStatus(workspace, config);
      const { pullDense, pullSparse } = resolveMissingConfiguredModelPullPlan({ config, status });
      if (pullDense || pullSparse) {
        await pullModels({ workspacePath: workspace, config, pullDense, pullSparse, progress: createProgressHandler(capture, global) });
      }
      emit(this.optsWithGlobals().json, capture, response("init", workspace, result), `Initialized workspace at ${workspace}`);
    });

  const source = program.command("source");
  source
    .description("Register, inspect, and manage workspace sources.");
  source.command("add")
    .description("Add a source definition. The source is enabled immediately. Use `page` for one page and `website` for multi-page crawling and feed detection.")
    .argument("<type>", `Source type: ${SOURCE_TYPE_LIST.join(", ")}`)
    .argument("<uri>", "Local path, URL, feed URL, or inline content depending on the source type.")
    .requiredOption("--name <name>")
    .option("--tag <tag...>", "Optional tags used later for filtering during search.")
    .option("--metadata <key=value...>", "Extra metadata fields stored on the source.")
    .option("--max-depth <n>", "Maximum crawl depth for website sources.")
    .option("--max-pages <n>", "Maximum number of pages to ingest from a website source.")
    .option("--max-concurrent-requests <n>", "Maximum remote requests in flight for a website or feed source.")
    .option("--include <pattern...>", "Only include matching paths or URLs.")
    .option("--exclude <pattern...>", "Skip matching paths or URLs.")
    .option("--render-js", "Render pages with JavaScript before extraction when supported.")
    .option("--no-robots", "Ignore robots.txt for website crawling. Use only when you control the target site or have permission.")
    .option("--rate-limit-ms <n>", "Delay between website requests.")
    .option("--retention-days <n>", "Retention window in days for RSS items. Defaults to the workspace crawler retention setting.")
    .addHelpText("after", `
Examples:
  qli source add directory ./docs --name "Local Docs" --tag docs
  qli source add file ./docs/auth.md --name "Auth Guide"
  qli source add page https://example.com/docs/auth --name "Auth Page"
  qli source add website https://example.com --name "Docs Site" --max-depth 2 --max-pages 50 --include /docs/
  qli source add website https://example.com --name "Docs Site" --max-concurrent-requests 8
  qli source add website https://example.com --name "Example Site" --json
  qli source add rss https://example.com/feed.xml --name "Release Feed"
  qli source add rss https://example.com/feed.xml --name "Release Feed" --max-concurrent-requests 3
  qli source add rss https://example.com/feed.xml --name "Release Feed" --retention-days 30

Notes:
  page stores one page. It does not crawl links or detect feeds.
  Website sources may detect one blog or news feed during registration.
  When a feed is added, qli also excludes the feed item prefix from the website crawl when it can infer one.
  Website and RSS sources default to 5 remote requests in flight per source unless config.yaml or source settings override it.
  Use --json when automation needs the full list of created sources.
  RSS sources store retention per feed.
  When you omit --retention-days for RSS, qli stores the workspace default from config.yaml.`)
    .action(async function command(typeInput: string, uri: string, options) {
      const type = parseSourceType(typeInput);
      if (!type) {
        throw new CliError(`unsupported source type: ${typeInput}`, "INVALID_ARGUMENT", ExitCode.InvalidArguments);
      }
      if (!SOURCE_TYPES.has(type)) {
        throw new CliError(`unsupported source type: ${type}`, "INVALID_ARGUMENT", ExitCode.InvalidArguments);
      }
      validateSourceAddOptions(type, options);
      const global = this.optsWithGlobals();
      const workspace = await resolveWorkspace({ workspace: global.workspace });
      const config = await loadConfig(workspace, global.config);
      const now = new Date().toISOString();
      const initialCrawl = createSourceCrawlConfig(type, options, { retentionDays: config.crawler.retentionDays });
      let crawl = initialCrawl;
      let detectedFeed: WebsiteFeedDiscovery | null = null;
      if (type === "website") {
        detectedFeed = await discoverWebsiteFeed(uri, config.crawler.defaultUserAgent);
        if (detectedFeed?.excludePrefix) {
          crawl = {
            ...(crawl ?? {}),
            excludePatterns: mergePatterns(crawl?.excludePatterns, detectedFeed.excludePrefix)
          };
        }
      }
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
      if (type !== "website") {
        emit(global.json, capture, response("source add", workspace, stored), `Added source ${stored.id}`);
        return;
      }

      let feedSource: Source | undefined;
      let feedWasAdded = false;
      if (detectedFeed) {
        const existingSources = await listSources(workspace);
        feedSource = existingSources.find((source) => source.uri === detectedFeed?.feedUrl);
        if (!feedSource) {
          feedSource = await addSource(workspace, {
            type: "rss",
            uri: detectedFeed.feedUrl,
            name: `${options.name} Feed`,
            enabled: true,
            tags: options.tag ?? [],
            metadata: normalizeMetadata(options.metadata),
            crawl: {
              retentionDays: config.crawler.retentionDays,
              fetchArticles: true
            },
            createdAt: now,
            updatedAt: now
          });
          feedWasAdded = true;
        }
      }

      const result: WebsiteSourceAddResult = {
        primarySource: stored,
        addedSources: [stored, ...(feedWasAdded && feedSource ? [feedSource] : [])],
        detectedFeed: detectedFeed
          ? {
              url: detectedFeed.feedUrl,
              discoveredBy: detectedFeed.discoveredBy,
              excludePrefix: detectedFeed.excludePrefix,
              source: feedSource,
              wasAdded: feedWasAdded
            }
          : null
      };
      emit(global.json, capture, response("source add", workspace, result), formatWebsiteSourceAdd(result));
    });

  source.command("config")
    .description("Edit supported settings on an existing source.")
    .argument("<sourceId>", "Source id from qli source list.")
    .option("--name <name>", "Update the source name.")
    .option("--tag <tag...>", "Replace source tags with the provided values.")
    .option("--metadata <key=value...>", "Merge metadata keys into the existing source metadata.")
    .option("--max-depth <n>", "Set website crawl depth.")
    .option("--max-pages <n>", "Set the page limit for website sources.")
    .option("--max-concurrent-requests <n>", "Set the remote request concurrency limit for website or feed sources.")
    .option("--include <pattern...>", "Set include patterns for website or directory sources.")
    .option("--exclude <pattern...>", "Set exclude patterns for website or directory sources.")
    .option("--retention-days <n>", "Set RSS retention in days for this feed.")
    .addHelpText("after", `
Examples:
  qli source config src_123 --retention-days 30
  qli source config src_123 --max-concurrent-requests 2
  qli source config src_123 --name "Docs Feed" --tag rss docs
  qli source config src_123 --include /docs/ --exclude /docs/archive/
  qli source config src_123 --metadata team=docs owner=platform --json

Notes:
  qli only exposes settings that the current source type uses at runtime.
  URI, source type, and source id do not change here.`)
    .action(async function command(sourceId: string, options: SourceConfigOptions) {
      const global = this.optsWithGlobals();
      const workspace = await resolveWorkspace({ workspace: global.workspace });
      const sources = await listSources(workspace);
      const current = sources.find((source) => source.id === sourceId);
      if (!current) {
        throw new CliError(`source not found: ${sourceId}`, "SOURCE_NOT_FOUND", ExitCode.SourceError);
      }
      const patch = buildSourceConfigPatch(current, options);
      if (Object.keys(patch).length === 0) {
        throw new CliError("no changes requested", "INVALID_ARGUMENT", ExitCode.InvalidArguments);
      }
      patch.updatedAt = new Date().toISOString();
      const updated = await updateSource(workspace, sourceId, patch);
      emit(global.json, capture, response("source config", workspace, updated), `Updated source ${sourceId}`);
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
    .description("Fetch source content, update affected chunks, and refresh retrieval indexes.")
    .option("--source <sourceId>", "Only ingest one source.")
    .option("--changed-only", "Skip content that has not changed since the last run.")
    .option("--dense", "Force a dense vector build if the dense model is available.")
    .option("--sparse", "Force a sparse vector build if the sparse runtime is available.")
    .addHelpText("after", `
Examples:
  qli ingest
  qli ingest --source src_123
  qli ingest --changed-only
  qli ingest --dense --sparse
  qli ingest --silent`)
    .action(async function command(options) {
      const global = this.optsWithGlobals();
      const workspace = await resolveWorkspace({ workspace: global.workspace });
      const result = await runIngestCommand({
        workspace,
        sourceId: options.source,
        changedOnly: Boolean(options.changedOnly),
        dense: Boolean(options.dense),
        sparse: Boolean(options.sparse),
        progress: createProgressHandler(capture, global)
      });
      emit(global.json, capture, response("ingest", workspace, result), `Processed ${result.ingest.processedSources} sources, wrote ${result.chunk.chunksWritten} chunks`);
    });

  program.command("chunk")
    .description("Split normalized documents into retrieval chunks.")
    .option("--source <sourceId>", "Only chunk documents from one source.")
    .option("--document <documentId>", "Only chunk one document.")
    .addHelpText("after", `
Examples:
  qli chunk
  qli chunk --source src_123
  qli chunk --document doc_123
  qli chunk --silent`)
    .action(async function command(options) {
      const global = this.optsWithGlobals();
      const workspace = await resolveWorkspace({ workspace: global.workspace });
      const result = await chunkDocuments({
        workspacePath: workspace,
        sourceId: options.source,
        documentId: options.document,
        progress: createProgressHandler(capture, global)
      });
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
  qli reprocess --document doc_123
  qli reprocess --silent`)
    .action(async function command(options) {
      const global = this.optsWithGlobals();
      const workspace = await resolveWorkspace({ workspace: global.workspace });
      const result = await reprocessDocuments({
        workspacePath: workspace,
        sourceId: options.source,
        documentId: options.document,
        progress: createProgressHandler(capture, global)
      });
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
  qli index build --dense --sparse
  qli index build --silent`)
    .action(async function command(options) {
    const global = this.optsWithGlobals();
    const workspace = await resolveWorkspace({ workspace: global.workspace });
    const result = await buildIndex({
      workspacePath: workspace,
      denseOverride: options.dense ? true : undefined,
      sparseOverride: options.sparse ? true : undefined,
      progress: createProgressHandler(capture, global)
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
  qli rebuild --dense --sparse
  qli rebuild --silent`)
    .action(async function command(options) {
      const global = this.optsWithGlobals();
      const workspace = await resolveWorkspace({ workspace: global.workspace });
      const progress = createProgressHandler(capture, global);
      progress?.("info", "Rebuild step 1/3: ingest");
      const ingest = await ingestSources({
        workspacePath: workspace,
        sourceIds: options.source ? [options.source] : undefined,
        changedOnly: Boolean(options.changedOnly),
        progress
      });
      progress?.("info", "Rebuild step 2/3: chunk");
      const chunk = await chunkDocuments({ workspacePath: workspace, sourceId: options.source, progress });
      progress?.("info", "Rebuild step 3/3: index");
      const indexBuild = await buildIndex({
        workspacePath: workspace,
        denseOverride: options.dense ? true : undefined,
        sparseOverride: options.sparse ? true : undefined,
        buildAvailableModels: true,
        progress
      });
      const data = { ingest, chunk, indexPath: indexBuild.indexPath, metadata: indexBuild.metadata };
      progress?.("info", "Rebuild complete");
      emit(global.json, capture, response("rebuild", workspace, data), `Processed ${ingest.processedSources} sources, wrote ${chunk.chunksWritten} chunks`);
    });

  program.command("search")
    .description("Search the built index and return ranked matching documents or chunks. Use search-json for raw JSON DSL queries.")
    .argument("[query]", "Text query. Omit it to list the latest matching documents.")
    .option("--top-k <n>", "Maximum number of results to return.", "12")
    .option("--source <sourceIds>", "Restrict results to one or more source ids. Use comma-separated values.")
    .option("--source-name <names>", "Restrict results to one or more source names. Use comma-separated values.")
    .option("--source-type <types>", `Restrict results to one or more source types. Use comma-separated values: ${SOURCE_TYPE_LIST.join(", ")}`)
    .option("--uri-prefix <prefixes>", "Restrict results to one or more URI prefixes. Use comma-separated values.")
    .option("--tag <tags>", "Restrict results to one or more source tags. Use comma-separated values.")
    .option("--metadata <key=value...>", "Restrict results to sources with matching metadata.")
    .option("--since <date>", "Shortcut for --publication-date-from.")
    .option("--until <date>", "Shortcut for --publication-date-to.")
    .option("--changed-since <date>", "Only include documents changed on or after this date.")
    .option("--has-publication-date", "Only include documents with a publication date.")
    .option("--publication-date-from <date>", "Only include documents published on or after this date.")
    .option("--publication-date-to <date>", "Only include documents published on or before this date.")
    .option("--first-seen-at-from <date>", "Only include documents first seen on or after this date.")
    .option("--first-seen-at-to <date>", "Only include documents first seen on or before this date.")
    .option("--last-seen-at-from <date>", "Only include documents last seen on or after this date.")
    .option("--last-seen-at-to <date>", "Only include documents last seen on or before this date.")
    .option("--last-changed-at-from <date>", "Only include documents changed on or after this date.")
    .option("--last-changed-at-to <date>", "Only include documents changed on or before this date.")
    .option("--crawled-at-from <date>", "Only include documents crawled on or after this date.")
    .option("--crawled-at-to <date>", "Only include documents crawled on or before this date.")
    .option("--retrieval <mode>", `Retrieval mode: ${RETRIEVAL_MODE_LIST.join(", ")}`)
    .option("--show-chunks", "Return chunk-level matches when available.")
    .addHelpText("after", `
Examples:
  qli search "pricing api limits"
  qli search "authentication" --top-k 20 --tag docs
  qli search --source-type rss --since 2026-05-01 --has-publication-date
  qli search --source-name "Release Feed,Company Blog" --uri-prefix https://example.com/news,https://example.com/blog
  qli search "billing" --metadata team=support
  qli search "embedding model" --retrieval hybrid --show-chunks
  qli search --source-type rss,page --top-k 25 --json

Notes:
  lexical works without vector models.
  dense, sparse, and hybrid require the relevant index artifacts to exist.
  Use search-json when you want the raw Querylight 0.11 JSON DSL and hit format.
  When you omit the query, qli returns the latest matching documents sorted by publication date.`)
    .action(async function command(query: string | undefined, options) {
      const global = this.optsWithGlobals();
      const workspace = await resolveWorkspace({ workspace: global.workspace });
      const result = await searchIndex({
        workspacePath: workspace,
        query: query ?? "",
        topK: Number(options.topK),
        sourceIds: parseCommaSeparatedList(options.source),
        sourceNames: parseCommaSeparatedList(options.sourceName),
        sourceTypes: parseSourceTypes(options.sourceType),
        uriPrefixes: parseCommaSeparatedList(options.uriPrefix),
        hasPublicationDate: Boolean(options.hasPublicationDate),
        tags: parseCommaSeparatedList(options.tag),
        metadata: ((options.metadata ?? []) as string[]).map(parseKeyValue).map(([key, value]: [string, string]) => ({ key, value })),
        dateRanges: searchDateRanges(options),
        retrievalMode: parseRetrievalMode(options.retrieval),
        showChunks: Boolean(options.showChunks)
      });
      emit(global.json, capture, response("search", workspace, result), formatSearchResults(result));
    });

  program.command("search-json")
    .description("Run a raw Querylight 0.11 JSON DSL search request against the lexical index.")
    .argument("<request>", "Inline JSON request or @path/to/request.json.")
    .addHelpText("after", `
Examples:
  qli search-json '{"query":{"match":{"text":"authentication"}},"size":5}'
  qli search-json @./search-request.json
  qli search-json '{"query":{"bool":{"filter":[{"term":{"sourceType":"rss"}}]}},"aggs":{"types":{"terms":{"field":"sourceType","size":5}}}}' --json

Notes:
  search-json uses the lexical index and Querylight 0.11 JSON DSL fields.
  Stored hit payloads are returned under _source.
  Use --json when another tool needs the full response envelope.`)
    .action(async function command(requestInput: string) {
      const global = this.optsWithGlobals();
      const workspace = await resolveWorkspace({ workspace: global.workspace });
      const request = await parseJsonArgument(requestInput);
      const result = await searchJsonIndex({
        workspacePath: workspace,
        request
      });
      emit(global.json, capture, response("search-json", workspace, result), JSON.stringify(result, null, 2));
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
  qli models pull --silent

Pulled model assets are shared under ~/.qli by default.
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
      await pullModels({ workspacePath: workspace, config, pullDense, pullSparse, progress: createProgressHandler(capture, global) });
      const data = {
        dense: pullDense
          ? {
              pulled: true,
              modelId: config.retrieval.dense.modelId,
              cacheDir: resolveCacheDir(workspace, config.retrieval.dense.cacheDir)
            }
          : undefined,
        sparse: pullSparse
          ? {
              pulled: true,
              modelId: config.retrieval.sparse.modelId,
              cacheDir: resolveCacheDir(workspace, config.retrieval.sparse.cacheDir)
            }
          : undefined
      };
      emit(global.json, capture, response("models pull", workspace, data), "Pulled available models");
    });

  models.command("status")
    .description("Show whether shared model assets, runtimes, and workspace vector artifacts are available.")
    .addHelpText("after", `
Examples:
  qli models status
  qli models status --json

The cacheDir fields show the resolved model cache path for the current workspace config.`)
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
      indexSize = (await stat(await resolveLatestIndexArtifactPath(workspace))).size;
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
      if (await isUvAvailable()) {
        checks.push("uv available for sparse runtime");
      } else {
        checks.push("uv missing for sparse runtime");
      }
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
