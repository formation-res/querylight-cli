import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import YAML from "yaml";
import type { WorkspaceConfig } from "../types/models.js";
import { DEFAULT_SHARED_MODEL_CACHE_DIR, LEGACY_WORKSPACE_MODEL_CACHE_DIR } from "./constants.js";

function normalizeModelCacheDir(configuredPath: string): string {
  return configuredPath === LEGACY_WORKSPACE_MODEL_CACHE_DIR
    ? DEFAULT_SHARED_MODEL_CACHE_DIR
    : configuredPath;
}

export const defaultConfig = (): WorkspaceConfig => ({
  workspaceVersion: 1,
  index: {
    name: "default",
    fields: {
      text: { type: "text", weight: 1.0 },
      title: { type: "text", weight: 2.0 },
      uri: { type: "keyword" },
      sourceId: { type: "keyword" },
      tags: { type: "keyword" },
      contentType: { type: "keyword" }
    },
    chunking: {
      maxChars: 1800,
      overlapChars: 200,
      minChars: 120,
      splitOnHeadings: true
    }
  },
  rag: {
    defaultTopK: 12,
    maxContextChars: 12000,
    citationStyle: "markdown"
  },
  search: {
    defaultTopK: 50
  },
  retrieval: {
    defaultMode: "lexical",
    dense: {
      enabled: true,
      modelId: "Xenova/paraphrase-MiniLM-L3-v2",
      cacheDir: DEFAULT_SHARED_MODEL_CACHE_DIR,
      indexHashTables: 8,
      indexRandomSeed: 42,
      chunkTextMode: "title-heading-text"
    },
    sparse: {
      enabled: true,
      modelId: "opensearch-project/opensearch-neural-sparse-encoding-doc-v2-mini",
      cacheDir: DEFAULT_SHARED_MODEL_CACHE_DIR,
      documentTopTokens: 128,
      queryEncoding: "tokenizer-token-weights",
      documentEncoding: "masked-lm-max-log1p-relu",
      chunkTextMode: "title-heading-text"
    }
  },
  crawler: {
    defaultUserAgent: "querylight-cli",
    obeyRobotsTxt: true,
    rateLimitMs: 1000,
    maxConcurrentRequests: 5,
    renderJs: false,
    retentionDays: 30,
    fetchArticles: true
  },
  limits: {
    maxFileSizeMb: 50,
    maxPagesPerSource: 100,
    maxTotalChunks: 100000
  }
});

export async function writeDefaultConfig(workspacePath: string, force = false): Promise<void> {
  const configPath = path.join(workspacePath, "config.yaml");
  try {
    if (!force) {
      await readFile(configPath, "utf8");
      return;
    }
  } catch {
    // fall through
  }
  await writeFile(configPath, YAML.stringify(defaultConfig()), "utf8");
}

export async function loadConfig(workspacePath: string, configPath?: string): Promise<WorkspaceConfig> {
  const resolved = configPath ?? path.join(workspacePath, "config.yaml");
  const raw = await readFile(resolved, "utf8");
  const parsed = YAML.parse(raw) as Partial<WorkspaceConfig>;
  const defaults = defaultConfig();
  return {
    ...defaults,
    ...parsed,
    index: {
      ...defaults.index,
      ...parsed.index,
      fields: {
        ...defaults.index.fields,
        ...(parsed.index?.fields ?? {})
      },
      chunking: {
        ...defaults.index.chunking,
        ...(parsed.index?.chunking ?? {})
      }
    },
    rag: {
      ...defaults.rag,
      ...(parsed.rag ?? {})
    },
    search: {
      ...defaults.search,
      ...(parsed.search ?? {})
    },
    retrieval: {
      ...defaults.retrieval,
      ...(parsed.retrieval ?? {}),
      dense: {
        ...defaults.retrieval.dense,
        ...(parsed.retrieval?.dense ?? {}),
        cacheDir: normalizeModelCacheDir(parsed.retrieval?.dense?.cacheDir ?? defaults.retrieval.dense.cacheDir)
      },
      sparse: {
        ...defaults.retrieval.sparse,
        ...(parsed.retrieval?.sparse ?? {}),
        cacheDir: normalizeModelCacheDir(parsed.retrieval?.sparse?.cacheDir ?? defaults.retrieval.sparse.cacheDir)
      }
    },
    crawler: {
      ...defaults.crawler,
      ...(parsed.crawler ?? {})
    },
    limits: {
      ...defaults.limits,
      ...(parsed.limits ?? {})
    }
  };
}
