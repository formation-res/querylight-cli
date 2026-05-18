import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { chunkDocuments } from "../src/chunk/chunker.js";
import { loadChunks } from "../src/chunk/chunk-store.js";
import { ensureWorkspace } from "../src/core/workspace.js";
import { buildIndex } from "../src/index/querylight-indexer.js";
import { ingestSources } from "../src/ingest/ingest-service.js";
import { createContext } from "../src/query/context-builder.js";
import { searchIndex } from "../src/query/search-service.js";
import { addSource } from "../src/sources/source-store.js";
import { cleanupTempDirs, tempWorkspace } from "./helpers.js";

let docsDir: string;

beforeEach(async () => {
  docsDir = await mkdtemp(path.join(os.tmpdir(), "qli-docs-"));
  await writeFile(path.join(docsDir, "auth.md"), "# API Authentication\n\nUse Bearer tokens.\n\n## Rotation\n\nRotate every 90 days.\n", "utf8");
  await writeFile(path.join(docsDir, "pricing.html"), "<main><h1>Pricing</h1><p>Starter includes 10000 requests.</p></main>", "utf8");
  await writeFile(path.join(docsDir, "notes.txt"), "Support escalation path and refund policy.", "utf8");
});

afterEach(async () => {
  await cleanupTempDirs();
  await import("node:fs/promises").then((fs) => fs.rm(docsDir, { recursive: true, force: true }));
});

describe("pipeline behavior", () => {
  it("tracks unchanged and changed documents across repeated ingestion", async () => {
    const root = await tempWorkspace();
    const { workspacePath } = await ensureWorkspace({ workspacePath: path.join(root, ".kb") });
    const source = await addSource(workspacePath, {
      type: "directory",
      uri: docsDir,
      name: "Docs",
      enabled: true,
      tags: ["docs"],
      metadata: { team: "platform" },
      createdAt: "2026-05-18T00:00:00.000Z",
      updatedAt: "2026-05-18T00:00:00.000Z"
    });

    const first = await ingestSources({ workspacePath, sourceIds: [source.id] });
    expect(first.documents.added).toBe(3);

    const second = await ingestSources({ workspacePath, sourceIds: [source.id] });
    expect(second.documents.unchanged).toBe(3);
    expect(second.documents.changed).toBe(0);

    await writeFile(path.join(docsDir, "auth.md"), "# API Authentication\n\nUse Bearer tokens and IP allowlists.\n", "utf8");
    const third = await ingestSources({ workspacePath, sourceIds: [source.id] });
    expect(third.documents.changed).toBe(1);
    expect(third.documents.unchanged).toBe(2);
  });

  it("detects actual changes when ingesting with changed-only", async () => {
    const root = await tempWorkspace();
    const { workspacePath } = await ensureWorkspace({ workspacePath: path.join(root, ".kb") });
    const source = await addSource(workspacePath, {
      type: "directory",
      uri: docsDir,
      name: "Docs",
      enabled: true,
      tags: ["docs"],
      metadata: { team: "platform" },
      createdAt: "2026-05-18T00:00:00.000Z",
      updatedAt: "2026-05-18T00:00:00.000Z"
    });

    await ingestSources({ workspacePath, sourceIds: [source.id] });
    await writeFile(path.join(docsDir, "auth.md"), "# API Authentication\n\nUse mutual TLS.\n", "utf8");

    const result = await ingestSources({ workspacePath, sourceIds: [source.id], changedOnly: true });
    expect(result.documents.changed).toBe(1);
    expect(result.documents.unchanged).toBe(2);
  });

  it("keeps unrelated chunks when chunking only one source", async () => {
    const root = await tempWorkspace();
    const { workspacePath } = await ensureWorkspace({ workspacePath: path.join(root, ".kb") });
    const docsA = await addSource(workspacePath, {
      type: "directory",
      uri: docsDir,
      name: "Docs A",
      enabled: true,
      tags: ["a"],
      metadata: { section: "a" },
      createdAt: "2026-05-18T00:00:00.000Z",
      updatedAt: "2026-05-18T00:00:00.000Z"
    });
    const otherDir = await mkdtemp(path.join(os.tmpdir(), "qli-other-"));
    await writeFile(path.join(otherDir, "other.md"), "# Other\n\nCompetitor pricing and features.", "utf8");
    const docsB = await addSource(workspacePath, {
      type: "directory",
      uri: otherDir,
      name: "Docs B",
      enabled: true,
      tags: ["b"],
      metadata: { section: "b" },
      createdAt: "2026-05-18T00:00:00.000Z",
      updatedAt: "2026-05-18T00:00:00.000Z"
    });

    await ingestSources({ workspacePath });
    await chunkDocuments({ workspacePath });
    const allChunks = await loadChunks(workspacePath);
    expect(new Set(allChunks.map((chunk) => chunk.sourceId))).toEqual(new Set([docsA.id, docsB.id]));

    await chunkDocuments({ workspacePath, sourceId: docsA.id });
    const afterFiltered = await loadChunks(workspacePath);
    expect(new Set(afterFiltered.map((chunk) => chunk.sourceId))).toEqual(new Set([docsA.id, docsB.id]));
  });

  it("builds searchable indexes with source, tag, and metadata filters", async () => {
    const root = await tempWorkspace();
    const { workspacePath } = await ensureWorkspace({ workspacePath: path.join(root, ".kb") });
    const source = await addSource(workspacePath, {
      type: "directory",
      uri: docsDir,
      name: "Docs",
      enabled: true,
      tags: ["support"],
      metadata: { team: "success" },
      createdAt: "2026-05-18T00:00:00.000Z",
      updatedAt: "2026-05-18T00:00:00.000Z"
    });

    await ingestSources({ workspacePath });
    await chunkDocuments({ workspacePath });
    await buildIndex({ workspacePath });

    const sourceFiltered = await searchIndex({ workspacePath, query: "authentication", topK: 5, sourceId: source.id });
    expect(sourceFiltered.results.length).toBeGreaterThan(0);

    const tagFiltered = await searchIndex({ workspacePath, query: "refund policy", topK: 5, tag: "support" });
    expect(tagFiltered.results.length).toBeGreaterThan(0);

    const metadataFiltered = await searchIndex({
      workspacePath,
      query: "starter requests",
      topK: 5,
      metadata: [{ key: "team", value: "success" }]
    });
    expect(metadataFiltered.results.length).toBeGreaterThan(0);
  });

  it("creates bounded context blocks with chunk citations", async () => {
    const root = await tempWorkspace();
    const { workspacePath } = await ensureWorkspace({ workspacePath: path.join(root, ".kb") });
    await addSource(workspacePath, {
      type: "directory",
      uri: docsDir,
      name: "Docs",
      enabled: true,
      tags: ["docs"],
      metadata: {},
      createdAt: "2026-05-18T00:00:00.000Z",
      updatedAt: "2026-05-18T00:00:00.000Z"
    });

    await ingestSources({ workspacePath });
    await chunkDocuments({ workspacePath });
    await buildIndex({ workspacePath });

    const context = await createContext({ workspacePath, query: "authentication", topK: 5, maxChars: 120 });
    expect(context.markdown).toContain("Chunk ID:");
    expect(context.sources.length).toBeGreaterThan(0);
    expect(context.sources.map((source) => source.text.length).reduce((sum, len) => sum + len, 0)).toBeLessThanOrEqual(120);
  });

  it("writes normalized markdown with frontmatter", async () => {
    const root = await tempWorkspace();
    const { workspacePath } = await ensureWorkspace({ workspacePath: path.join(root, ".kb") });
    const source = await addSource(workspacePath, {
      type: "directory",
      uri: docsDir,
      name: "Docs",
      enabled: true,
      tags: ["docs"],
      metadata: {},
      createdAt: "2026-05-18T00:00:00.000Z",
      updatedAt: "2026-05-18T00:00:00.000Z"
    });
    await ingestSources({ workspacePath, sourceIds: [source.id] });

    const normalizedDir = path.join(workspacePath, "normalized");
    const fs = await import("node:fs/promises");
    const files = await fs.readdir(normalizedDir);
    const authFile = files.find((file) => file.endsWith(".md"));
    const body = await readFile(path.join(normalizedDir, authFile!), "utf8");
    expect(body).toContain("documentId:");
    expect(body).toContain("sourceId:");
  });
});
