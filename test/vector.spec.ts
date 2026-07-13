import { writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ensureWorkspace } from "../src/core/workspace.js";
import { loadConfig } from "../src/core/config.js";
import { writeJsonl } from "../src/core/jsonl.js";
import { buildIndex } from "../src/index/querylight-indexer.js";
import { findRelatedDocuments } from "../src/query/related-service.js";
import { searchIndex, searchResultsFromResponse } from "../src/query/search-service.js";
import { createContext } from "../src/query/context-builder.js";
import { readDensePayload, readSparsePayload, writeDensePayload } from "../src/vector/store.js";
import { createDenseChunkText, createSparseChunkText } from "../src/vector/text.js";
import { setDenseEmbedderFactoryForTests } from "../src/vector/dense.js";
import { normalizeSparseDocumentText, setSparseDocumentBuilderFactoryForTests, setSparseQueryEncoderFactoryForTests } from "../src/vector/sparse.js";
import { cleanupTempDirs, tempWorkspace } from "./helpers.js";

function fakeDenseEmbedding(text: string): number[] {
  const lower = text.toLowerCase();
  return [
    lower.includes("bm25") ? 10 : 0,
    lower.includes("sparse") ? 10 : 0,
    lower.includes("token") ? 5 : 0
  ];
}

afterEach(async () => {
  setDenseEmbedderFactoryForTests(null);
  setSparseDocumentBuilderFactoryForTests(null);
  setSparseQueryEncoderFactoryForTests(null);
  delete process.env.QLI_HOME;
  await cleanupTempDirs();
});

describe("vector helpers and retrieval", () => {
  it("includes retrieval defaults in config", async () => {
    const root = await tempWorkspace("qli-vector-");
    process.env.QLI_HOME = path.join(root, ".qli-home");
    const { workspacePath } = await ensureWorkspace({ workspacePath: path.join(root, ".kb") });
    const config = await loadConfig(workspacePath);

    expect(config.retrieval.defaultMode).toBe("lexical");
    expect(config.retrieval.dense.enabled).toBe(true);
    expect(config.retrieval.sparse.enabled).toBe(true);
    expect(config.retrieval.dense.modelId).toBe("Xenova/paraphrase-MiniLM-L3-v2");
    expect(config.retrieval.sparse.modelId).toBe("opensearch-project/opensearch-neural-sparse-encoding-doc-v2-mini");
    expect(config.retrieval.dense.cacheDir).toBe("~/.qli/models/huggingface");
  });

  it("disposes dense embedders after vector builds", async () => {
    const root = await tempWorkspace("qli-vector-");
    process.env.QLI_HOME = path.join(root, ".qli-home");
    const { workspacePath } = await ensureWorkspace({ workspacePath: path.join(root, ".kb") });
    await writeJsonl(path.join(workspacePath, "chunks", "chunks.jsonl"), [
      {
        id: "chunk1",
        documentId: "doc1",
        sourceId: "src1",
        title: "Doc",
        uri: "file:///doc.md",
        headingPath: [],
        text: "dense text",
        contentHash: "c1",
        metadata: {},
        firstSeenAt: "2026-05-18T00:00:00.000Z",
        lastSeenAt: "2026-05-18T00:00:00.000Z",
        lastChangedAt: "2026-05-18T00:00:00.000Z"
      }
    ]);

    let disposed = false;
    setDenseEmbedderFactoryForTests(async () => ({
      async embed() {
        return [1, 0, 0];
      },
      async dispose() {
        disposed = true;
      }
    }));

    await buildIndex({ workspacePath, denseOverride: true, sparseOverride: false });
    expect(disposed).toBe(true);
  });

  it("builds dense and sparse chunk text from title heading and body", () => {
    const chunk = {
      id: "chunk1",
      documentId: "doc1",
      sourceId: "src1",
      title: "Documentation",
      uri: "https://example.com/docs",
      headingPath: ["Ranking", "BM25"],
      text: "BM25 ranking chooses term-weight scoring.",
      contentHash: "hash",
      metadata: {},
      firstSeenAt: "2026-05-18T00:00:00.000Z",
      lastSeenAt: "2026-05-18T00:00:00.000Z",
      lastChangedAt: "2026-05-18T00:00:00.000Z"
    };

    expect(createDenseChunkText(chunk)).toContain("Documentation");
    expect(createDenseChunkText(chunk)).toContain("Ranking");
    expect(createSparseChunkText(chunk)).toContain("BM25 ranking chooses");
  });

  it("drops low-signal headings from vector text", () => {
    const chunk = {
      id: "chunk1",
      documentId: "doc1",
      sourceId: "src1",
      title: "NemoClaw Setup",
      uri: "https://example.com/nemoclaw",
      headingPath: ["Overview", "What You Get"],
      text: "## What You Get\n\nSet up NemoClaw as a controlled OpenClaw and OpenShell stack.",
      contentHash: "hash",
      metadata: {},
      firstSeenAt: "2026-05-18T00:00:00.000Z",
      lastSeenAt: "2026-05-18T00:00:00.000Z",
      lastChangedAt: "2026-05-18T00:00:00.000Z"
    };

    const denseText = createDenseChunkText(chunk);
    expect(denseText).toContain("NemoClaw Setup");
    expect(denseText).toContain("controlled OpenClaw and OpenShell stack");
    expect(denseText).not.toContain("Overview");
    expect(denseText).not.toContain("What You Get");
  });

  it("normalizes sparse payload text to a tokenizer-safe string", () => {
    expect(normalizeSparseDocumentText("hello\u0000world")).toBe("hello world");
    expect(normalizeSparseDocumentText(null)).toBe("");
    expect(normalizeSparseDocumentText({ nested: true })).toBe("{\"nested\":true}");
    expect(normalizeSparseDocumentText(new Uint8Array([104, 105]))).toBe("hi");
  });

  it("builds dense and sparse vector artifacts and searches all retrieval modes", async () => {
    const root = await tempWorkspace("qli-vector-");
    process.env.QLI_HOME = path.join(root, ".qli-home");
    const { workspacePath } = await ensureWorkspace({ workspacePath: path.join(root, ".kb") });
    await writeJsonl(path.join(workspacePath, "sources", "sources.jsonl"), [
      {
        id: "src1",
        type: "directory",
        name: "Docs",
        uri: "/tmp/docs",
        enabled: true,
        tags: ["docs"],
        metadata: {},
        createdAt: "2026-05-18T00:00:00.000Z",
        updatedAt: "2026-05-18T00:00:00.000Z"
      }
    ]);
    await writeJsonl(path.join(workspacePath, "documents", "documents.jsonl"), [
      {
        id: "doc1",
        sourceId: "src1",
        sourceType: "directory",
        title: "BM25",
        uri: "file:///bm25.md",
        mimeType: "text/markdown",
        normalizedPath: "unused",
        contentHash: "hash1",
        metadata: { tags: ["docs"] },
        firstSeenAt: "2026-05-18T00:00:00.000Z",
        lastSeenAt: "2026-05-18T00:00:00.000Z",
        lastChangedAt: "2026-05-18T00:00:00.000Z"
      },
      {
        id: "doc2",
        sourceId: "src1",
        sourceType: "directory",
        title: "Sparse",
        uri: "file:///sparse.md",
        mimeType: "text/markdown",
        normalizedPath: "unused",
        contentHash: "hash2",
        metadata: { tags: ["docs"] },
        firstSeenAt: "2026-05-18T00:00:00.000Z",
        lastSeenAt: "2026-05-18T00:00:00.000Z",
        lastChangedAt: "2026-05-18T00:00:00.000Z"
      }
    ]);
    await writeJsonl(path.join(workspacePath, "chunks", "chunks.jsonl"), [
      {
        id: "chunk-bm25",
        documentId: "doc1",
        sourceId: "src1",
        title: "BM25",
        uri: "file:///bm25.md",
        headingPath: ["Ranking"],
        text: "BM25 ranking explains lexical term weighting.",
        contentHash: "c1",
        metadata: { tags: ["docs"] },
        firstSeenAt: "2026-05-18T00:00:00.000Z",
        lastSeenAt: "2026-05-18T00:00:00.000Z",
        lastChangedAt: "2026-05-18T00:00:00.000Z"
      },
      {
        id: "chunk-sparse",
        documentId: "doc2",
        sourceId: "src1",
        title: "Sparse",
        uri: "file:///sparse.md",
        headingPath: ["Vectors"],
        text: "Sparse vector search uses token weights.",
        contentHash: "c2",
        metadata: { tags: ["docs"] },
        firstSeenAt: "2026-05-18T00:00:00.000Z",
        lastSeenAt: "2026-05-18T00:00:00.000Z",
        lastChangedAt: "2026-05-18T00:00:00.000Z"
      }
    ]);

    setDenseEmbedderFactoryForTests(async () => async (text) => fakeDenseEmbedding(text));
    setSparseDocumentBuilderFactoryForTests(async (_workspacePath, _config, chunks) => ({
      queryTokenWeights: [0, 0, 7, 11],
      vocabularySize: 4,
      chunks: chunks.map((chunk) => ({
        chunkId: chunk.id,
        documentId: chunk.documentId,
        sourceId: chunk.sourceId,
        title: chunk.title,
        uri: chunk.uri,
        headingPath: chunk.headingPath,
        text: chunk.text,
        vector: (chunk.id === "chunk-bm25" ? { "2": 7 } : { "3": 11 }) as Record<string, number>
      }))
    }));
    setSparseQueryEncoderFactoryForTests(async () => async (text) => (text.toLowerCase().includes("bm25") ? { "2": 7 } : { "3": 11 }) as Record<string, number>);

    const build = await buildIndex({ workspacePath, denseOverride: true, sparseOverride: true });
    expect(build.denseBuilt).toBe(true);
    expect(build.sparseBuilt).toBe(true);
    expect((await readDensePayload(workspacePath)).chunks).toHaveLength(2);
    expect((await readSparsePayload(workspacePath)).chunks).toHaveLength(2);

    const lexical = await searchIndex({ workspacePath, query: "bm25 ranking", topK: 5, retrievalMode: "lexical" });
    expect(lexical.retrievalMode).toBe("lexical");
    expect(searchResultsFromResponse(lexical)[0]?.chunkId).toBe("chunk-bm25");

    const dense = await searchIndex({ workspacePath, query: "bm25 ranking", topK: 5, retrievalMode: "dense" });
    expect(searchResultsFromResponse(dense)[0]?.chunkId).toBe("chunk-bm25");

    const sparse = await searchIndex({ workspacePath, query: "sparse token weights", topK: 5, retrievalMode: "sparse" });
    expect(searchResultsFromResponse(sparse)[0]?.chunkId).toBe("chunk-sparse");

    const hybrid = await searchIndex({ workspacePath, query: "bm25 ranking", topK: 5, retrievalMode: "hybrid" });
    expect(hybrid.retrievalMode).toBe("hybrid");
    expect(searchResultsFromResponse(hybrid)[0]?.chunkId).toBe("chunk-bm25");

    const context = await createContext({ workspacePath, query: "bm25 ranking", topK: 5, maxChars: 500, retrievalMode: "hybrid" });
    expect(context.retrievalMode).toBe("hybrid");
    expect(context.markdown).toContain("Chunk ID:");
  });

  it("keeps sparse builds alive when a single chunk is skipped", async () => {
    const root = await tempWorkspace("qli-vector-");
    process.env.QLI_HOME = path.join(root, ".qli-home");
    const { workspacePath } = await ensureWorkspace({ workspacePath: path.join(root, ".kb") });
    await writeJsonl(path.join(workspacePath, "sources", "sources.jsonl"), [
      {
        id: "src1",
        type: "directory",
        name: "Docs",
        uri: "/tmp/docs",
        enabled: true,
        tags: ["docs"],
        metadata: {},
        createdAt: "2026-05-18T00:00:00.000Z",
        updatedAt: "2026-05-18T00:00:00.000Z"
      }
    ]);
    await writeJsonl(path.join(workspacePath, "documents", "documents.jsonl"), [
      {
        id: "doc1",
        sourceId: "src1",
        sourceType: "directory",
        title: "Good",
        uri: "file:///good.md",
        mimeType: "text/markdown",
        normalizedPath: "unused",
        contentHash: "hash1",
        metadata: { tags: ["docs"] },
        firstSeenAt: "2026-05-18T00:00:00.000Z",
        lastSeenAt: "2026-05-18T00:00:00.000Z",
        lastChangedAt: "2026-05-18T00:00:00.000Z"
      },
      {
        id: "doc2",
        sourceId: "src1",
        sourceType: "directory",
        title: "Bad",
        uri: "file:///bad.md",
        mimeType: "text/markdown",
        normalizedPath: "unused",
        contentHash: "hash2",
        metadata: { tags: ["docs"] },
        firstSeenAt: "2026-05-18T00:00:00.000Z",
        lastSeenAt: "2026-05-18T00:00:00.000Z",
        lastChangedAt: "2026-05-18T00:00:00.000Z"
      }
    ]);
    await writeJsonl(path.join(workspacePath, "chunks", "chunks.jsonl"), [
      {
        id: "chunk-good",
        documentId: "doc1",
        sourceId: "src1",
        title: "Good",
        uri: "file:///good.md",
        headingPath: [],
        text: "good content",
        contentHash: "c1",
        metadata: { tags: ["docs"] },
        firstSeenAt: "2026-05-18T00:00:00.000Z",
        lastSeenAt: "2026-05-18T00:00:00.000Z",
        lastChangedAt: "2026-05-18T00:00:00.000Z"
      },
      {
        id: "chunk-bad",
        documentId: "doc2",
        sourceId: "src1",
        title: "Bad",
        uri: "file:///bad.md",
        headingPath: [],
        text: "bad content",
        contentHash: "c2",
        metadata: { tags: ["docs"] },
        firstSeenAt: "2026-05-18T00:00:00.000Z",
        lastSeenAt: "2026-05-18T00:00:00.000Z",
        lastChangedAt: "2026-05-18T00:00:00.000Z"
      }
    ]);

    setDenseEmbedderFactoryForTests(async () => async () => [1, 0, 0]);
    setSparseDocumentBuilderFactoryForTests(async (_workspacePath, _config, chunks) => ({
      queryTokenWeights: [0, 0, 7],
      vocabularySize: 3,
      skippedChunks: [{ chunkId: "chunk-bad", error: "TypeError: tokenizer rejected input" }],
      chunks: chunks.map((chunk) => ({
        chunkId: chunk.id,
        documentId: chunk.documentId,
        sourceId: chunk.sourceId,
        title: chunk.title,
        uri: chunk.uri,
        headingPath: chunk.headingPath,
        text: chunk.text,
        vector: (chunk.id === "chunk-good" ? { "2": 7 } : {}) as Record<string, number>
      }))
    }));

    const progress: string[] = [];
    const build = await buildIndex({
      workspacePath,
      denseOverride: true,
      sparseOverride: true,
      progress: (_level, message) => {
        progress.push(message);
      }
    });

    expect(build.sparseBuilt).toBe(true);
    const sparse = await readSparsePayload(workspacePath);
    expect(sparse.chunks).toHaveLength(2);
    expect(sparse.chunks.find((chunk) => chunk.chunkId === "chunk-bad")?.vector).toEqual({});
    expect(progress).toContain("Skipped sparse vectors for 1 chunk due to encoding errors");
    expect(progress).toContain("Skipped sparse chunk chunk-bad: TypeError: tokenizer rejected input");
  });

  it("finds related documents from dense document embeddings", async () => {
    const root = await tempWorkspace("qli-vector-");
    process.env.QLI_HOME = path.join(root, ".qli-home");
    const { workspacePath } = await ensureWorkspace({ workspacePath: path.join(root, ".kb") });
    await writeFile(path.join(workspacePath, "config.yaml"), "retrieval:\n  dense:\n    enabled: true\n  sparse:\n    enabled: false\n", "utf8");
    await writeJsonl(path.join(workspacePath, "sources", "sources.jsonl"), [
      {
        id: "src1",
        type: "directory",
        name: "Docs",
        uri: "/tmp/docs",
        enabled: true,
        tags: ["docs"],
        metadata: {},
        createdAt: "2026-05-18T00:00:00.000Z",
        updatedAt: "2026-05-18T00:00:00.000Z"
      }
    ]);
    await writeJsonl(path.join(workspacePath, "documents", "documents.jsonl"), [
      {
        id: "doc-bm25",
        sourceId: "src1",
        sourceType: "directory",
        title: "BM25 Guide",
        uri: "file:///bm25.md",
        mimeType: "text/markdown",
        normalizedPath: "unused",
        contentHash: "hash1",
        metadata: { tags: ["docs"] },
        firstSeenAt: "2026-05-18T00:00:00.000Z",
        lastSeenAt: "2026-05-18T00:00:00.000Z",
        lastChangedAt: "2026-05-18T00:00:00.000Z"
      },
      {
        id: "doc-bm25-advanced",
        sourceId: "src1",
        sourceType: "directory",
        title: "Advanced BM25",
        uri: "file:///bm25-advanced.md",
        mimeType: "text/markdown",
        normalizedPath: "unused",
        contentHash: "hash2",
        metadata: { tags: ["docs"] },
        firstSeenAt: "2026-05-18T00:00:00.000Z",
        lastSeenAt: "2026-05-18T00:00:00.000Z",
        lastChangedAt: "2026-05-18T00:00:00.000Z"
      },
      {
        id: "doc-sparse",
        sourceId: "src1",
        sourceType: "directory",
        title: "Sparse Search",
        uri: "file:///sparse.md",
        mimeType: "text/markdown",
        normalizedPath: "unused",
        contentHash: "hash3",
        metadata: { tags: ["docs"] },
        firstSeenAt: "2026-05-18T00:00:00.000Z",
        lastSeenAt: "2026-05-18T00:00:00.000Z",
        lastChangedAt: "2026-05-18T00:00:00.000Z"
      }
    ]);
    await writeJsonl(path.join(workspacePath, "chunks", "chunks.jsonl"), [
      {
        id: "chunk-bm25-a",
        documentId: "doc-bm25",
        sourceId: "src1",
        title: "BM25 Guide",
        uri: "file:///bm25.md",
        headingPath: ["Ranking"],
        text: "BM25 ranking explains lexical term weighting.",
        contentHash: "c1",
        metadata: { tags: ["docs"] },
        firstSeenAt: "2026-05-18T00:00:00.000Z",
        lastSeenAt: "2026-05-18T00:00:00.000Z",
        lastChangedAt: "2026-05-18T00:00:00.000Z"
      },
      {
        id: "chunk-bm25-b",
        documentId: "doc-bm25-advanced",
        sourceId: "src1",
        title: "Advanced BM25",
        uri: "file:///bm25-advanced.md",
        headingPath: ["Deep Dive"],
        text: "Advanced BM25 tuning covers ranking behavior and token weighting.",
        contentHash: "c2",
        metadata: { tags: ["docs"] },
        firstSeenAt: "2026-05-18T00:00:00.000Z",
        lastSeenAt: "2026-05-18T00:00:00.000Z",
        lastChangedAt: "2026-05-18T00:00:00.000Z"
      },
      {
        id: "chunk-sparse",
        documentId: "doc-sparse",
        sourceId: "src1",
        title: "Sparse Search",
        uri: "file:///sparse.md",
        headingPath: ["Vectors"],
        text: "Sparse vector search uses token weights and expansion.",
        contentHash: "c3",
        metadata: { tags: ["docs"] },
        firstSeenAt: "2026-05-18T00:00:00.000Z",
        lastSeenAt: "2026-05-18T00:00:00.000Z",
        lastChangedAt: "2026-05-18T00:00:00.000Z"
      }
    ]);

    setDenseEmbedderFactoryForTests(async () => async (text) => fakeDenseEmbedding(text));

    await buildIndex({ workspacePath, denseOverride: true });

    const related = await findRelatedDocuments({
      workspacePath,
      document: "doc-bm25",
      topK: 5
    });

    expect(related.retrievalMode).toBe("dense");
    expect(related.sourceDocument.documentId).toBe("doc-bm25");
    expect(related.results[0]?.documentId).toBe("doc-bm25-advanced");
    expect(related.results[0]?.score).toBeGreaterThan(related.results[1]?.score ?? -1);
  });

  it("falls back to exact dense scoring when the approximate index returns no candidates", async () => {
    const root = await tempWorkspace("qli-vector-");
    process.env.QLI_HOME = path.join(root, ".qli-home");
    const { workspacePath } = await ensureWorkspace({ workspacePath: path.join(root, ".kb") });
    await writeFile(path.join(workspacePath, "config.yaml"), "retrieval:\n  dense:\n    enabled: true\n  sparse:\n    enabled: false\n", "utf8");
    await writeJsonl(path.join(workspacePath, "sources", "sources.jsonl"), [
      {
        id: "src1",
        type: "directory",
        name: "Docs",
        uri: "/tmp/docs",
        enabled: true,
        tags: ["docs"],
        metadata: {},
        createdAt: "2026-05-18T00:00:00.000Z",
        updatedAt: "2026-05-18T00:00:00.000Z"
      }
    ]);
    await writeJsonl(path.join(workspacePath, "documents", "documents.jsonl"), [
      {
        id: "doc1",
        sourceId: "src1",
        sourceType: "directory",
        title: "BM25",
        uri: "file:///bm25.md",
        mimeType: "text/markdown",
        normalizedPath: "unused",
        contentHash: "hash1",
        metadata: { tags: ["docs"] },
        firstSeenAt: "2026-05-18T00:00:00.000Z",
        lastSeenAt: "2026-05-18T00:00:00.000Z",
        lastChangedAt: "2026-05-18T00:00:00.000Z"
      },
      {
        id: "doc2",
        sourceId: "src1",
        sourceType: "directory",
        title: "Sparse",
        uri: "file:///sparse.md",
        mimeType: "text/markdown",
        normalizedPath: "unused",
        contentHash: "hash2",
        metadata: { tags: ["docs"] },
        firstSeenAt: "2026-05-18T00:00:00.000Z",
        lastSeenAt: "2026-05-18T00:00:00.000Z",
        lastChangedAt: "2026-05-18T00:00:00.000Z"
      }
    ]);
    await writeJsonl(path.join(workspacePath, "chunks", "chunks.jsonl"), [
      {
        id: "chunk-bm25",
        documentId: "doc1",
        sourceId: "src1",
        title: "BM25",
        uri: "file:///bm25.md",
        headingPath: ["Ranking"],
        text: "BM25 ranking explains lexical term weighting.",
        contentHash: "c1",
        metadata: { tags: ["docs"] },
        firstSeenAt: "2026-05-18T00:00:00.000Z",
        lastSeenAt: "2026-05-18T00:00:00.000Z",
        lastChangedAt: "2026-05-18T00:00:00.000Z"
      },
      {
        id: "chunk-sparse",
        documentId: "doc2",
        sourceId: "src1",
        title: "Sparse",
        uri: "file:///sparse.md",
        headingPath: ["Vectors"],
        text: "Sparse vector search uses token weights.",
        contentHash: "c2",
        metadata: { tags: ["docs"] },
        firstSeenAt: "2026-05-18T00:00:00.000Z",
        lastSeenAt: "2026-05-18T00:00:00.000Z",
        lastChangedAt: "2026-05-18T00:00:00.000Z"
      }
    ]);

    setDenseEmbedderFactoryForTests(async () => async (text) => fakeDenseEmbedding(text));
    await buildIndex({ workspacePath, denseOverride: true });

    const densePayload = await readDensePayload(workspacePath);
    await writeDensePayload(workspacePath, {
      ...densePayload,
      indexState: {
        ...densePayload.indexState,
        vectors: {}
      }
    });

    const dense = await searchIndex({ workspacePath, query: "bm25 ranking", topK: 5, retrievalMode: "dense" });
    expect(searchResultsFromResponse(dense)[0]?.chunkId).toBe("chunk-bm25");
  });

});
