import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import YAML from "yaml";
import type { WorkspaceConfig } from "../types/models.js";

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
  crawler: {
    defaultUserAgent: "querylight-cli/0.1",
    obeyRobotsTxt: true,
    rateLimitMs: 1000,
    renderJs: false
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
  return YAML.parse(raw) as WorkspaceConfig;
}
