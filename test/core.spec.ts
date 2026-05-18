import { mkdtemp, readFile, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildIndex } from "../src/index/querylight-indexer.js";
import { chunkDocuments } from "../src/chunk/chunker.js";
import { ensureWorkspace } from "../src/core/workspace.js";
import { writeJsonl } from "../src/core/jsonl.js";
import { ingestSources } from "../src/ingest/ingest-service.js";
import { searchIndex } from "../src/query/search-service.js";
import { loadConfig } from "../src/core/config.js";
import { addSource, listSources } from "../src/sources/source-store.js";
import { createContext } from "../src/query/context-builder.js";
import { diffWorkspace, renderChangeReport } from "../src/report/diff-service.js";
import type { Source } from "../src/types/models.js";

const tempDirs: string[] = [];

async function tempWorkspace(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "qli-test-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map(async (dir) => {
    await import("node:fs/promises").then((fs) => fs.rm(dir, { recursive: true, force: true }));
  }));
});

describe("workspace lifecycle", () => {
  it("creates the full workspace layout and default config", async () => {
    const workspace = await tempWorkspace();
    const result = await ensureWorkspace({ workspacePath: path.join(workspace, ".kb") });
    const config = await loadConfig(result.workspacePath);

    expect(config.workspaceVersion).toBe(1);
    await expect(stat(path.join(result.workspacePath, "sources"))).resolves.toBeDefined();
    await expect(stat(path.join(result.workspacePath, "documents"))).resolves.toBeDefined();
    await expect(stat(path.join(result.workspacePath, "chunks"))).resolves.toBeDefined();
    await expect(stat(path.join(result.workspacePath, "indexes"))).resolves.toBeDefined();
  });

  it("stores sources with duplicate URI protection", async () => {
    const workspace = await tempWorkspace();
    const { workspacePath } = await ensureWorkspace({ workspacePath: path.join(workspace, ".kb") });
    const source: Source = {
      id: "src_docs",
      type: "directory",
      name: "Docs",
      uri: path.resolve("test-fixtures/docs"),
      enabled: true,
      tags: ["docs"],
      metadata: {},
      createdAt: "2026-05-18T00:00:00.000Z",
      updatedAt: "2026-05-18T00:00:00.000Z"
    };

    await addSource(workspacePath, source);
    await expect(addSource(workspacePath, source)).rejects.toThrow(/duplicate/i);

    const stored = await listSources(workspacePath);
    expect(stored).toHaveLength(1);
  });
});

describe("ingest, chunk, index, query", () => {
  it("runs end to end for a local directory", async () => {
    const root = await tempWorkspace();
    const { workspacePath } = await ensureWorkspace({ workspacePath: path.join(root, ".kb") });
    const source = await addSource(workspacePath, {
      id: "src_local_docs",
      type: "directory",
      name: "Local Docs",
      uri: path.resolve("test-fixtures/docs"),
      enabled: true,
      tags: ["docs"],
      metadata: {},
      createdAt: "2026-05-18T00:00:00.000Z",
      updatedAt: "2026-05-18T00:00:00.000Z"
    });

    const ingestRun = await ingestSources({ workspacePath, sourceIds: [source.id] });
    expect(ingestRun.documents.added + ingestRun.documents.changed + ingestRun.documents.unchanged).toBe(3);

    const chunkRun = await chunkDocuments({ workspacePath });
    expect(chunkRun.chunksWritten).toBeGreaterThan(2);

    const indexRun = await buildIndex({ workspacePath });
    expect(indexRun.metadata.chunkCount).toBe(chunkRun.chunksWritten);

    const search = await searchIndex({
      workspacePath,
      query: "API authentication",
      topK: 5
    });
    expect(search.results[0]?.title).toContain("API Authentication");

    const context = await createContext({
      workspacePath,
      query: "How do I authenticate API requests?",
      topK: 5,
      maxChars: 4000
    });
    expect(context.markdown).toContain("# Context");
    expect(context.sources[0]?.chunkId).toBeTruthy();
  });

  it("writes stable index state that can be reloaded for search", async () => {
    const root = await tempWorkspace();
    const { workspacePath } = await ensureWorkspace({ workspacePath: path.join(root, ".kb") });
    await writeJsonl(path.join(workspacePath, "chunks", "chunks.jsonl"), [
      {
        id: "chunk1",
        documentId: "doc1",
        sourceId: "src1",
        title: "Auth",
        uri: "file:///auth.md",
        headingPath: ["API Authentication"],
        text: "Use the Authorization Bearer token header.",
        tokenEstimate: 6,
        contentHash: "hash1",
        metadata: { tags: ["docs"] },
        firstSeenAt: "2026-05-18T00:00:00.000Z",
        lastSeenAt: "2026-05-18T00:00:00.000Z",
        lastChangedAt: "2026-05-18T00:00:00.000Z"
      }
    ]);

    const build = await buildIndex({ workspacePath });
    const latest = JSON.parse(await readFile(path.join(workspacePath, "indexes", "latest.json"), "utf8")) as object;
    expect(latest).toBeTruthy();

    const search = await searchIndex({ workspacePath, query: "bearer token", topK: 5 });
    expect(search.results[0]?.chunkId).toBe("chunk1");
    expect(build.metadata.indexHash.length).toBeGreaterThan(10);
  });

  it("prefers a specific article page over an aggregate page when both match", async () => {
    const root = await tempWorkspace();
    const { workspacePath } = await ensureWorkspace({ workspacePath: path.join(root, ".kb") });
    await writeJsonl(path.join(workspacePath, "chunks", "chunks.jsonl"), [
      {
        id: "chunk-aggregate",
        documentId: "doc-aggregate",
        sourceId: "src1",
        title: "BoostingQuery for Soft Demotion Instead of Hard Exclusion",
        uri: "https://querylight.tryformation.com/docs/",
        headingPath: ["Docs", "Static article pages", "BoostingQuery for Soft Demotion Instead of Hard Exclusion"],
        text: "BoostingQuery for Soft Demotion Instead of Hard Exclusion helps push down undesirable candidates in search results.",
        tokenEstimate: 20,
        contentHash: "hash-aggregate",
        metadata: { tags: ["docs"] },
        firstSeenAt: "2026-05-18T00:00:00.000Z",
        lastSeenAt: "2026-05-18T00:00:00.000Z",
        lastChangedAt: "2026-05-18T00:00:00.000Z"
      },
      {
        id: "chunk-detail-1",
        documentId: "doc-detail",
        sourceId: "src1",
        title: "BoostingQuery for Soft Demotion Instead of Hard Exclusion",
        uri: "https://querylight.tryformation.com/docs/lexical-querying/boosting-query/",
        headingPath: ["BoostingQuery for Soft Demotion Instead of Hard Exclusion"],
        text: "BoostingQuery explains soft demotion and how to keep relevant documents while lowering undesirable results.",
        tokenEstimate: 22,
        contentHash: "hash-detail-1",
        metadata: { tags: ["docs"] },
        firstSeenAt: "2026-05-18T00:00:00.000Z",
        lastSeenAt: "2026-05-18T00:00:00.000Z",
        lastChangedAt: "2026-05-18T00:00:00.000Z"
      },
      {
        id: "chunk-detail-2",
        documentId: "doc-detail",
        sourceId: "src1",
        title: "BoostingQuery for Soft Demotion Instead of Hard Exclusion",
        uri: "https://querylight.tryformation.com/docs/lexical-querying/boosting-query/",
        headingPath: ["BoostingQuery for Soft Demotion Instead of Hard Exclusion", "Why use it"],
        text: "Use BoostingQuery when you want soft demotion instead of hard exclusion for weak or undesirable matches.",
        tokenEstimate: 20,
        contentHash: "hash-detail-2",
        metadata: { tags: ["docs"] },
        firstSeenAt: "2026-05-18T00:00:00.000Z",
        lastSeenAt: "2026-05-18T00:00:00.000Z",
        lastChangedAt: "2026-05-18T00:00:00.000Z"
      }
    ]);

    await buildIndex({ workspacePath });

    const search = await searchIndex({ workspacePath, query: "boostingquery soft demotion undesirable results", topK: 5 });
    expect(search.results[0]?.documentId).toBe("doc-detail");
    expect(search.results[0]?.uri).toBe("https://querylight.tryformation.com/docs/lexical-querying/boosting-query/");
    expect(search.results.some((result) => result.documentId === "doc-aggregate" && result.title === "BoostingQuery for Soft Demotion Instead of Hard Exclusion")).toBe(false);
  });

  it("reports changed documents and markdown change reports", async () => {
    const root = await tempWorkspace();
    const { workspacePath } = await ensureWorkspace({ workspacePath: path.join(root, ".kb") });
    await writeJsonl(path.join(workspacePath, "documents", "documents.jsonl"), [
      {
        id: "doc1",
        sourceId: "src1",
        sourceType: "file",
        title: "Doc 1",
        uri: "file:///doc1.md",
        mimeType: "text/markdown",
        normalizedPath: path.join(workspacePath, "normalized", "doc1.md"),
        contentHash: "hash-new",
        metadata: {},
        firstSeenAt: "2026-05-01T00:00:00.000Z",
        lastSeenAt: "2026-05-18T00:00:00.000Z",
        lastChangedAt: "2026-05-18T00:00:00.000Z"
      }
    ]);
    await writeJsonl(path.join(workspacePath, "runs", "2026-05-17.json"), [
      {
        kind: "ingest",
        documentsSnapshot: [
          {
            id: "doc1",
            title: "Doc 1",
            uri: "file:///doc1.md",
            contentHash: "hash-old",
            lastChangedAt: "2026-05-01T00:00:00.000Z",
            sourceId: "src1"
          }
        ]
      }
    ]);

    const diff = await diffWorkspace({ workspacePath, since: "2026-05-01T00:00:00.000Z" });
    expect(diff.changedDocuments[0]?.id).toBe("doc1");

    const report = renderChangeReport(diff);
    expect(report).toContain("# Knowledge Base Change Report");
    expect(report).toContain("Changed Documents");
  });
});
