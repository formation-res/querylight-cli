import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ensureWorkspace } from "../src/core/workspace.js";
import { loadConfig } from "../src/core/config.js";
import { writeJsonl } from "../src/core/jsonl.js";
import { buildIndex } from "../src/index/querylight-indexer.js";
import { searchIndex } from "../src/query/search-service.js";
import { createContext } from "../src/query/context-builder.js";
import { readDensePayload, readSparsePayload } from "../src/vector/store.js";
import { createDenseChunkText, createSparseChunkText } from "../src/vector/text.js";
import { setDenseEmbedderFactoryForTests } from "../src/vector/dense.js";
import { setSparseDocumentBuilderFactoryForTests, setSparseQueryEncoderFactoryForTests } from "../src/vector/sparse.js";
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
  await cleanupTempDirs();
});

describe("vector helpers and retrieval", () => {
  it("includes retrieval defaults in config", async () => {
    const root = await tempWorkspace("qli-vector-");
    const { workspacePath } = await ensureWorkspace({ workspacePath: path.join(root, ".kb") });
    const config = await loadConfig(workspacePath);

    expect(config.retrieval.defaultMode).toBe("lexical");
    expect(config.retrieval.dense.modelId).toBe("Xenova/all-MiniLM-L6-v2");
    expect(config.retrieval.sparse.modelId).toBe("opensearch-project/opensearch-neural-sparse-encoding-doc-v3-distill");
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

  it("builds dense and sparse vector artifacts and searches all retrieval modes", async () => {
    const root = await tempWorkspace("qli-vector-");
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
    expect(lexical.results[0]?.chunkId).toBe("chunk-bm25");

    const dense = await searchIndex({ workspacePath, query: "bm25 ranking", topK: 5, retrievalMode: "dense" });
    expect(dense.results[0]?.chunkId).toBe("chunk-bm25");

    const sparse = await searchIndex({ workspacePath, query: "sparse token weights", topK: 5, retrievalMode: "sparse" });
    expect(sparse.results[0]?.chunkId).toBe("chunk-sparse");

    const hybrid = await searchIndex({ workspacePath, query: "bm25 ranking", topK: 5, retrievalMode: "hybrid" });
    expect(hybrid.retrievalMode).toBe("hybrid");
    expect(hybrid.results[0]?.chunkId).toBe("chunk-bm25");

    const context = await createContext({ workspacePath, query: "bm25 ranking", topK: 5, maxChars: 500, retrievalMode: "hybrid" });
    expect(context.retrievalMode).toBe("hybrid");
    expect(context.markdown).toContain("Chunk ID:");
  });
});
