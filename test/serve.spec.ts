import { rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runCli } from "../src/cli/run-cli.js";
import { packageWorkspaceArchive } from "../src/core/archive.js";
import { startSearchApiServer } from "../src/server/search-api.js";
import { cleanupTempDirs, tempWorkspace } from "./helpers.js";

afterEach(async () => {
  delete process.env.QLI_HOME;
  await cleanupTempDirs();
});

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
      expect(parsed.hits.hits[0]?._source.title).toContain("API Authentication");
      expect(parsed.hits.hits[0]?._index).toBe("default");
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
