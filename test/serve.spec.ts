import { rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runCli } from "../src/cli/run-cli.js";
import { packageWorkspaceArchive } from "../src/core/archive.js";
import { writeJsonl } from "../src/core/jsonl.js";
import { ensureWorkspace } from "../src/core/workspace.js";
import { buildIndex } from "../src/index/querylight-indexer.js";
import { startSearchApiServer } from "../src/server/search-api.js";
import { setDenseEmbedderFactoryForTests } from "../src/vector/dense.js";
import { setSparseDocumentBuilderFactoryForTests, setSparseQueryEncoderFactoryForTests } from "../src/vector/sparse.js";
import { cleanupTempDirs, tempWorkspace } from "./helpers.js";

afterEach(async () => {
  setDenseEmbedderFactoryForTests(null);
  setSparseDocumentBuilderFactoryForTests(null);
  setSparseQueryEncoderFactoryForTests(null);
  delete process.env.QLI_HOME;
  await cleanupTempDirs();
});

function fakeDenseEmbedding(text: string): number[] {
  const lower = text.toLowerCase();
  return [
    lower.includes("bm25") ? 10 : 0,
    lower.includes("sparse") ? 10 : 0,
    lower.includes("authentication") ? 5 : 0
  ];
}

async function buildWorkspace(basePath: string, docsName: string): Promise<string> {
  const workspace = path.join(basePath, ".kb");
  process.env.QLI_HOME = path.join(basePath, ".qli-home");
  await runCli(["init", "--workspace", workspace]);
  await writeFile(path.join(workspace, "config.yaml"), "retrieval:\n  dense:\n    enabled: false\n  sparse:\n    enabled: false\n", "utf8");
  await runCli([
    "source",
    "add",
    "directory",
    path.resolve("test-fixtures/docs"),
    "--workspace",
    workspace,
    "--name",
    docsName
  ]);
  await runCli(["ingest", "--workspace", workspace]);
  return workspace;
}

async function buildVectorWorkspace(basePath: string): Promise<string> {
  process.env.QLI_HOME = path.join(basePath, ".qli-home");
  const { workspacePath } = await ensureWorkspace({ workspacePath: path.join(basePath, ".kb") });
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
      id: "doc-sparse",
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
      documentId: "doc-bm25",
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
      documentId: "doc-sparse",
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
  await buildIndex({ workspacePath, denseOverride: true, sparseOverride: true });
  return workspacePath;
}

describe("search api server", () => {
  it("serves _search for a single workspace", async () => {
    const root = await tempWorkspace("qli-serve-");
    const workspace = await buildWorkspace(root, "Local Docs");
    const server = await startSearchApiServer({ workspacePath: workspace, host: "127.0.0.1", port: 0 });

    try {
      const response = await fetch(`${server.url}/_search`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          query: {
            match: {
              text: "authentication"
            }
          },
          size: 5
        })
      });
      const parsed = await response.json() as { hits: { hits: Array<{ _index: string; _source: { title: string } }> } };

      expect(response.status).toBe(200);
      expect(parsed.hits.hits[0]?._source.title).toContain("API Authentication");
      expect(parsed.hits.hits[0]?._index).toBe("default");
    } finally {
      await server.close();
    }
  });

  it("serves _search for a packaged workspace zip", async () => {
    const root = await tempWorkspace("qli-serve-zip-");
    const workspace = await buildWorkspace(root, "Local Docs");
    const archive = path.join(root, "docs-kb.zip");
    await packageWorkspaceArchive({ workspacePath: workspace, outputPath: archive });
    const server = await startSearchApiServer({ workspacePath: archive, host: "127.0.0.1", port: 0 });

    try {
      const response = await fetch(`${server.url}/_search`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          query: {
            match: {
              text: "authentication"
            }
          },
          size: 5
        })
      });
      const parsed = await response.json() as { hits: { hits: Array<{ _index: string; _source: { title: string } }> } };

      expect(response.status).toBe(200);
      expect(server.knowledgeBases[0]?.storage).toBe("archive");
      expect(server.knowledgeBases[0]?.workspacePath).toBe(archive);
      expect(parsed.hits.hits[0]?._source.title).toContain("API Authentication");
      expect(parsed.hits.hits[0]?._index).toBe("default");
    } finally {
      await server.close();
    }
  });

  it("serves inference and JSON DSL vector queries", async () => {
    const root = await tempWorkspace("qli-serve-vector-");
    const workspace = await buildVectorWorkspace(root);
    const server = await startSearchApiServer({ workspacePath: workspace, host: "127.0.0.1", port: 0 });

    try {
      const inferenceResponse = await fetch(`${server.url}/_infer`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text: "sparse token weights", mode: "both" })
      });
      const inference = await inferenceResponse.json() as {
        dense: { vector: number[] };
        sparse: { vector: Record<string, number> };
        fields: { dense: string; sparse: string };
      };

      expect(inferenceResponse.status).toBe(200);
      expect(inference.fields).toEqual({ dense: "embedding", sparse: "sparse" });
      expect(inference.dense.vector).toEqual([0, 10, 0]);
      expect(inference.sparse.vector).toEqual({ "3": 11 });

      const sparseResponse = await fetch(`${server.url}/_search`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          sparse_vector: {
            field: "sparse",
            vector: inference.sparse.vector,
            k: 5
          },
          size: 5
        })
      });
      const sparseParsed = await sparseResponse.json() as { hits: { hits: Array<{ _id: string }> } };

      expect(sparseResponse.status).toBe(200);
      expect(sparseParsed.hits.hits[0]?._id).toBe("chunk-sparse");

      const hybridResponse = await fetch(`${server.url}/_search`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          query: {
            rrf: {
              queries: [
                { match: { text: "bm25 ranking" } },
                {
                  knn: {
                    field: "embedding",
                    vector: fakeDenseEmbedding("bm25 ranking"),
                    k: 5
                  }
                },
                {
                  sparse_vector: {
                    field: "sparse",
                    vector: { "2": 7 },
                    k: 5
                  }
                }
              ],
              rank_constant: 20,
              weights: [3, 1, 1]
            }
          },
          size: 5
        })
      });
      const hybridParsed = await hybridResponse.json() as { hits: { hits: Array<{ _id: string }> } };

      expect(hybridResponse.status).toBe(200);
      expect(hybridParsed.hits.hits[0]?._id).toBe("chunk-bm25");
    } finally {
      await server.close();
    }
  });

  it("serves _simplesearch with one-step hybrid retrieval", async () => {
    const root = await tempWorkspace("qli-serve-simple-vector-");
    const workspace = await buildVectorWorkspace(root);
    const server = await startSearchApiServer({ workspacePath: workspace, host: "127.0.0.1", port: 0 });

    try {
      const response = await fetch(`${server.url}/_simplesearch`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          query: "sparse token weights",
          topK: 5
        })
      });
      const parsed = await response.json() as { retrievalMode: string; hits: { hits: Array<{ _id: string }> } };

      expect(response.status).toBe(200);
      expect(parsed.retrievalMode).toBe("hybrid");
      expect(parsed.hits.hits[0]?._id).toBe("chunk-sparse");
    } finally {
      await server.close();
    }
  });

  it("serves _simplesearch with CLI-style filters from query params", async () => {
    const root = await tempWorkspace("qli-serve-simple-");
    const workspace = await buildWorkspace(root, "Local Docs");
    const server = await startSearchApiServer({ workspacePath: workspace, host: "127.0.0.1", port: 0 });

    try {
      const response = await fetch(`${server.url}/_simplesearch?q=authentication&top-k=5&source-type=directory&show-chunks=true`, {
        method: "GET"
      });
      const parsed = await response.json() as { retrievalMode: string; hits: { hits: Array<{ _source: { title: string; text?: string } }> } };

      expect(response.status).toBe(200);
      expect(parsed.retrievalMode).toBe("hybrid");
      expect(parsed.hits.hits[0]?._source.title).toContain("API Authentication");
      expect(parsed.hits.hits[0]?._source.text?.toLowerCase()).toContain("authentication");
    } finally {
      await server.close();
    }
  });

  it("serves multiple knowledge bases from a parent directory and keeps searches working after index files are removed", async () => {
    const root = await tempWorkspace("qli-serve-multi-");
    const alphaRoot = path.join(root, "alpha");
    const betaRoot = path.join(root, "beta");
    const alphaWorkspace = await buildWorkspace(alphaRoot, "Alpha Docs");
    const betaWorkspace = await buildWorkspace(betaRoot, "Beta Docs");
    const server = await startSearchApiServer({ workspacePath: root, host: "127.0.0.1", port: 0 });

    try {
      await rm(path.join(alphaWorkspace, "indexes"), { recursive: true, force: true });
      await rm(path.join(betaWorkspace, "indexes"), { recursive: true, force: true });

      const alphaResponse = await fetch(`${server.url}/alpha/_search`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          query: {
            match: {
              text: "authentication"
            }
          },
          size: 3
        })
      });
      const betaResponse = await fetch(`${server.url}/beta/_search`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          query: {
            match: {
              text: "authentication"
            }
          },
          size: 3
        })
      });
      const alphaParsed = await alphaResponse.json() as { hits: { hits: Array<{ _index: string }> } };
      const betaParsed = await betaResponse.json() as { hits: { hits: Array<{ _index: string }> } };

      expect(alphaResponse.status).toBe(200);
      expect(betaResponse.status).toBe(200);
      expect(alphaParsed.hits.hits[0]?._index).toBe("alpha");
      expect(betaParsed.hits.hits[0]?._index).toBe("beta");
    } finally {
      await server.close();
    }
  });

  it("lists available knowledge base prefixes", async () => {
    const root = await tempWorkspace("qli-serve-list-");
    const alphaRoot = path.join(root, "alpha-src");
    const betaRoot = path.join(root, "beta-src");
    const alphaWorkspace = await buildWorkspace(alphaRoot, "Alpha Docs");
    const betaWorkspace = await buildWorkspace(betaRoot, "Beta Docs");
    await packageWorkspaceArchive({ workspacePath: alphaWorkspace, outputPath: path.join(root, "alpha.zip") });
    await packageWorkspaceArchive({ workspacePath: betaWorkspace, outputPath: path.join(root, "beta.zip") });
    await rm(alphaRoot, { recursive: true, force: true });
    await rm(betaRoot, { recursive: true, force: true });
    const server = await startSearchApiServer({ workspacePath: root, host: "127.0.0.1", port: 0 });

    try {
      const response = await fetch(`${server.url}/_knowledge_bases`);
      const parsed = await response.json() as {
        mode: string;
        prefixes: string[];
        knowledgeBases: Array<{ name: string; prefix: string; route: string; simpleSearchRoute: string; inferenceRoute: string; storage: string }>;
      };

      expect(response.status).toBe(200);
      expect(parsed.mode).toBe("multi");
      expect(parsed.prefixes.sort()).toEqual(["/alpha", "/beta"]);
      expect(parsed.knowledgeBases.map((knowledgeBase) => knowledgeBase.route).sort()).toEqual(["/alpha/_search", "/beta/_search"]);
      expect(parsed.knowledgeBases.map((knowledgeBase) => knowledgeBase.simpleSearchRoute).sort()).toEqual(["/alpha/_simplesearch", "/beta/_simplesearch"]);
      expect(parsed.knowledgeBases.map((knowledgeBase) => knowledgeBase.inferenceRoute).sort()).toEqual(["/alpha/_infer", "/beta/_infer"]);
      expect(parsed.knowledgeBases.every((knowledgeBase) => knowledgeBase.storage === "archive")).toBe(true);
    } finally {
      await server.close();
    }
  });

  it("serves API help with inference and hybrid query examples", async () => {
    const root = await tempWorkspace("qli-serve-help-");
    const workspace = await buildWorkspace(root, "Local Docs");
    const server = await startSearchApiServer({ workspacePath: workspace, host: "127.0.0.1", port: 0 });

    try {
      const response = await fetch(`${server.url}/_help`);
      const parsed = await response.json() as {
        capabilities: {
          inference: { routes: string[] };
          simpleSearch: { routes: string[]; requestBody: { retrieval: string } };
          search: { clauses: string[]; vectorFields: { dense: string; sparse: string } };
        };
        queryExamples: { vectorDsl: Array<{ body: unknown }> };
      };

      expect(response.status).toBe(200);
      expect(parsed.capabilities.inference.routes).toContain("/_infer");
      expect(parsed.capabilities.simpleSearch.routes).toContain("/_simplesearch");
      expect(parsed.capabilities.simpleSearch.requestBody.retrieval).toContain("Defaults to hybrid");
      expect(parsed.capabilities.search.clauses).toContain("rrf");
      expect(parsed.capabilities.search.vectorFields).toEqual({ dense: "embedding", sparse: "sparse" });
      expect(JSON.stringify(parsed.queryExamples.vectorDsl)).toContain("sparse_vector");
    } finally {
      await server.close();
    }
  });

  it("serves multiple packaged knowledge bases from a parent directory", async () => {
    const root = await tempWorkspace("qli-serve-multi-zip-");
    const alphaRoot = path.join(root, "alpha-src");
    const betaRoot = path.join(root, "beta-src");
    const alphaWorkspace = await buildWorkspace(alphaRoot, "Alpha Docs");
    const betaWorkspace = await buildWorkspace(betaRoot, "Beta Docs");
    await packageWorkspaceArchive({ workspacePath: alphaWorkspace, outputPath: path.join(root, "alpha.zip") });
    await packageWorkspaceArchive({ workspacePath: betaWorkspace, outputPath: path.join(root, "beta.zip") });
    await rm(alphaRoot, { recursive: true, force: true });
    await rm(betaRoot, { recursive: true, force: true });
    const server = await startSearchApiServer({ workspacePath: root, host: "127.0.0.1", port: 0 });

    try {
      const alphaResponse = await fetch(`${server.url}/alpha/_search`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ query: { match: { text: "authentication" } }, size: 3 })
      });
      const betaResponse = await fetch(`${server.url}/beta/_search`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ query: { match: { text: "authentication" } }, size: 3 })
      });
      const alphaParsed = await alphaResponse.json() as { hits: { hits: Array<{ _index: string }> } };
      const betaParsed = await betaResponse.json() as { hits: { hits: Array<{ _index: string }> } };

      expect(alphaResponse.status).toBe(200);
      expect(betaResponse.status).toBe(200);
      expect(alphaParsed.hits.hits[0]?._index).toBe("alpha");
      expect(betaParsed.hits.hits[0]?._index).toBe("beta");
    } finally {
      await server.close();
    }
  });

});
