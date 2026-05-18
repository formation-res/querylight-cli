import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { saveChunks } from "../src/chunk/chunk-store.js";
import { writeJsonl } from "../src/core/jsonl.js";
import { chunkDocuments } from "../src/chunk/chunker.js";
import { buildChunksForDocument } from "../src/chunk/chunker.js";
import { loadChunks } from "../src/chunk/chunk-store.js";
import { ensureWorkspace } from "../src/core/workspace.js";
import { loadConfig } from "../src/core/config.js";
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

  it("supports source, uri, and date filters and lists latest documents when query is omitted", async () => {
    const root = await tempWorkspace();
    const { workspacePath } = await ensureWorkspace({ workspacePath: path.join(root, ".kb") });
    const rssSource = await addSource(workspacePath, {
      type: "rss",
      uri: "https://example.com/feed.xml",
      name: "Release Feed",
      enabled: true,
      tags: ["news"],
      metadata: {},
      createdAt: "2026-05-18T00:00:00.000Z",
      updatedAt: "2026-05-18T00:00:00.000Z"
    });
    const docsSource = await addSource(workspacePath, {
      type: "directory",
      uri: docsDir,
      name: "Docs",
      enabled: true,
      tags: ["docs"],
      metadata: {},
      createdAt: "2026-05-18T00:00:00.000Z",
      updatedAt: "2026-05-18T00:00:00.000Z"
    });

    const olderPath = path.join(workspacePath, "normalized", "rss-old.md");
    const newerPath = path.join(workspacePath, "normalized", "rss-new.md");
    const docsPath = path.join(workspacePath, "normalized", "docs.md");
    await writeFile(olderPath, "# Older Release\n\nFirst article body.\n", "utf8");
    await writeFile(newerPath, "# New Release\n\nSecond article body.\n", "utf8");
    await writeFile(docsPath, "# Product Docs\n\nReference material.\n", "utf8");

    const documents = [
      {
        id: "doc-rss-old",
        sourceId: rssSource.id,
        sourceType: "rss" as const,
        title: "Older Release",
        uri: "https://example.com/old",
        sourceUri: rssSource.uri,
        mimeType: "text/markdown",
        normalizedPath: olderPath,
        contentHash: "hash-old",
        metadata: { tags: ["news"], sourceType: "rss" },
        publicationDate: "2026-05-10T09:00:00.000Z",
        firstSeenAt: "2026-05-10T10:00:00.000Z",
        lastSeenAt: "2026-05-10T10:00:00.000Z",
        lastChangedAt: "2026-05-10T10:00:00.000Z"
      },
      {
        id: "doc-rss-new",
        sourceId: rssSource.id,
        sourceType: "rss" as const,
        title: "New Release",
        uri: "https://example.com/new",
        sourceUri: rssSource.uri,
        mimeType: "text/markdown",
        normalizedPath: newerPath,
        contentHash: "hash-new",
        metadata: { tags: ["news"], sourceType: "rss" },
        publicationDate: "2026-05-17T09:00:00.000Z",
        firstSeenAt: "2026-05-17T10:00:00.000Z",
        lastSeenAt: "2026-05-17T10:00:00.000Z",
        lastChangedAt: "2026-05-17T10:00:00.000Z"
      },
      {
        id: "doc-docs",
        sourceId: docsSource.id,
        sourceType: "directory" as const,
        title: "Product Docs",
        uri: "file:///docs/reference",
        sourceUri: docsSource.uri,
        mimeType: "text/markdown",
        normalizedPath: docsPath,
        contentHash: "hash-docs",
        metadata: { tags: ["docs"], sourceType: "directory" },
        firstSeenAt: "2026-05-16T10:00:00.000Z",
        lastSeenAt: "2026-05-16T10:00:00.000Z",
        lastChangedAt: "2026-05-16T10:00:00.000Z"
      }
    ];
    await writeJsonl(path.join(workspacePath, "documents", "documents.jsonl"), documents);
    await saveChunks(workspacePath, [
      {
        id: "chunk-rss-old",
        documentId: "doc-rss-old",
        sourceId: rssSource.id,
        title: "Older Release",
        uri: "https://example.com/old",
        headingPath: ["Older Release"],
        text: "First article body.",
        contentHash: "chunk-hash-old",
        metadata: { tags: ["news"], sourceType: "rss" },
        firstSeenAt: "2026-05-10T10:00:00.000Z",
        lastSeenAt: "2026-05-10T10:00:00.000Z",
        lastChangedAt: "2026-05-10T10:00:00.000Z"
      },
      {
        id: "chunk-rss-new",
        documentId: "doc-rss-new",
        sourceId: rssSource.id,
        title: "New Release",
        uri: "https://example.com/new",
        headingPath: ["New Release"],
        text: "Second article body.",
        contentHash: "chunk-hash-new",
        metadata: { tags: ["news"], sourceType: "rss" },
        firstSeenAt: "2026-05-17T10:00:00.000Z",
        lastSeenAt: "2026-05-17T10:00:00.000Z",
        lastChangedAt: "2026-05-17T10:00:00.000Z"
      },
      {
        id: "chunk-docs",
        documentId: "doc-docs",
        sourceId: docsSource.id,
        title: "Product Docs",
        uri: "file:///docs/reference",
        headingPath: ["Product Docs"],
        text: "Reference material.",
        contentHash: "chunk-hash-docs",
        metadata: { tags: ["docs"], sourceType: "directory" },
        firstSeenAt: "2026-05-16T10:00:00.000Z",
        lastSeenAt: "2026-05-16T10:00:00.000Z",
        lastChangedAt: "2026-05-16T10:00:00.000Z"
      }
    ]);
    await buildIndex({ workspacePath });

    const latestRss = await searchIndex({
      workspacePath,
      query: "",
      topK: 5,
      sourceNames: ["release feed", "missing source"],
      sourceTypes: ["rss", "url"],
      uriPrefixes: ["https://example.com/ne", "https://example.com/unused"],
      hasPublicationDate: true,
      dateRanges: [
        { field: "publicationDate", from: "2026-05-11T00:00:00.000Z" },
        { field: "lastChangedAt", from: "2026-05-17T00:00:00.000Z" }
      ]
    });

    expect(latestRss.results).toHaveLength(1);
    expect(latestRss.results[0]?.title).toBe("New Release");
    expect(latestRss.results[0]?.sourceType).toBe("rss");
    expect(latestRss.results[0]?.publicationDate).toBe("2026-05-17T09:00:00.000Z");
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

  it("does not explode chunk counts when a long section ends near the overlap boundary", async () => {
    const root = await tempWorkspace();
    const { workspacePath } = await ensureWorkspace({ workspacePath: path.join(root, ".kb") });
    const config = await loadConfig(workspacePath);
    const repeated = "A".repeat(1200);
    const markdown = `# Title\n\n${repeated}\n\nshort tail\n\n${"B".repeat(1200)}`;
    const document = {
      id: "doc1",
      sourceId: "src1",
      sourceType: "markdown" as const,
      title: "Title",
      uri: "inline:doc1",
      sourceUri: "inline:doc1",
      mimeType: "text/markdown",
      normalizedPath: "unused",
      contentHash: "hash",
      metadata: {},
      firstSeenAt: "2026-05-18T00:00:00.000Z",
      lastSeenAt: "2026-05-18T00:00:00.000Z",
      lastChangedAt: "2026-05-18T00:00:00.000Z"
    };

    const chunks = buildChunksForDocument(document, markdown, config);
    expect(chunks.length).toBeLessThan(10);
    expect(Math.min(...chunks.map((chunk) => chunk.text.length))).toBeGreaterThan(20);
  });
});
