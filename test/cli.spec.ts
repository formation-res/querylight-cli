import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runCli } from "../src/cli/run-cli.js";
import { setDenseEmbedderFactoryForTests } from "../src/vector/dense.js";
import { setPullModelsForTests } from "../src/vector/service.js";
import { denseVectorPath, writeDensePullMarker } from "../src/vector/store.js";
import packageJson from "../package.json" with { type: "json" };

const tempDirs: string[] = [];

async function tempWorkspace(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "qli-cli-test-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  setDenseEmbedderFactoryForTests(null);
  delete process.env.QLI_HOME;
  vi.unstubAllGlobals();
  await Promise.all(tempDirs.splice(0).map(async (dir) => {
    await import("node:fs/promises").then((fs) => fs.rm(dir, { recursive: true, force: true }));
  }));
});

describe("cli json output", () => {
  it("returns stable command envelopes", async () => {
    const root = await tempWorkspace();
    const workspace = path.join(root, ".kb");
    process.env.QLI_HOME = path.join(root, ".qli-home");
    const init = await runCli(["init", "--workspace", workspace, "--json"]);
    const initParsed = JSON.parse(init.stdout);

    expect(init.exitCode).toBe(0);
    expect(initParsed.ok).toBe(true);
    expect(initParsed.command).toBe("init");
    expect(initParsed.version).toBe(packageJson.version);
    await writeFile(path.join(workspace, "config.yaml"), "retrieval:\n  dense:\n    enabled: false\n  sparse:\n    enabled: false\n", "utf8");

    const add = await runCli([
      "source",
      "add",
      "directory",
      path.resolve("test-fixtures/docs"),
      "--workspace",
      workspace,
      "--name",
      "Local Docs",
      "--tag",
      "docs",
      "--json"
    ]);
    const addParsed = JSON.parse(add.stdout);
    expect(addParsed.ok).toBe(true);

    const ingest = await runCli(["ingest", "--workspace", workspace, "--json"]);
    const ingestParsed = JSON.parse(ingest.stdout);
    expect(ingestParsed.ok).toBe(true);
    expect(ingestParsed.data.indexPath).toContain("indexes");

    const search = await runCli(["search", "authentication", "--workspace", workspace, "--json"]);
    const searchParsed = JSON.parse(search.stdout);
    expect(searchParsed.ok).toBe(true);
    expect(searchParsed.data.hits.hits[0]._source.title).toContain("API Authentication");
  });

  it("packages a workspace and searches the zip directly", async () => {
    const root = await tempWorkspace();
    const workspace = path.join(root, ".kb");
    const archive = path.join(root, "docs-kb.zip");
    process.env.QLI_HOME = path.join(root, ".qli-home");

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
      "Local Docs"
    ]);
    await runCli(["ingest", "--workspace", workspace]);

    const packaged = await runCli(["package", archive, "--workspace", workspace, "--json"]);
    const packagedParsed = JSON.parse(packaged.stdout);
    expect(packaged.exitCode).toBe(0);
    expect(packagedParsed.data.archivePath).toBe(archive);
    await expect(stat(archive)).resolves.toBeDefined();

    const search = await runCli(["search", "authentication", "--workspace", archive, "--json"]);
    const searchParsed = JSON.parse(search.stdout);
    expect(search.exitCode).toBe(0);
    expect(searchParsed.data.hits.hits[0]._source.title).toContain("API Authentication");

    const rebuild = await runCli(["rebuild", "--workspace", archive, "--json"]);
    const error = JSON.parse(rebuild.stderr);
    expect(rebuild.exitCode).toBe(3);
    expect(error.error.code).toBe("WORKSPACE_ERROR");
    expect(error.error.message).toContain("zip workspaces are read-only");
  });

  it("returns related documents from the CLI", async () => {
    const root = await tempWorkspace();
    const workspace = path.join(root, ".kb");
    process.env.QLI_HOME = path.join(root, ".qli-home");
    const fakeDenseEmbedding = (text: string): number[] => {
      const lower = text.toLowerCase();
      return [
        1 + (lower.includes("auth") ? 10 : 0),
        lower.includes("bearer") ? 8 : 1,
        lower.includes("pricing") ? 6 : 1
      ];
    };
    setDenseEmbedderFactoryForTests(async () => async (text) => fakeDenseEmbedding(text));

    await runCli(["init", "--workspace", workspace]);
    await writeFile(path.join(workspace, "config.yaml"), "retrieval:\n  dense:\n    enabled: true\n  sparse:\n    enabled: false\n", "utf8");
    await runCli([
      "source",
      "add",
      "directory",
      path.resolve("test-fixtures/docs"),
      "--workspace",
      workspace,
      "--name",
      "Local Docs",
      "--tag",
      "docs"
    ]);
    await runCli(["rebuild", "--workspace", workspace, "--dense"]);

    const documents = readFile(path.join(workspace, "documents", "documents.jsonl"), "utf8");
    const authDocument = (await documents)
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { id: string; title: string })
      .find((document) => document.title.includes("Authentication"));
    expect(authDocument?.id).toBeTruthy();

    const related = await runCli(["related", authDocument!.id, "--workspace", workspace, "--json"]);
    const parsed = JSON.parse(related.stdout);

    expect(related.exitCode).toBe(0);
    expect(parsed.ok).toBe(true);
    expect(parsed.command).toBe("related");
    expect(parsed.data.sourceDocument.documentId).toBeTruthy();
    expect(Array.isArray(parsed.data.results)).toBe(true);
  });

  it("uses search.defaultTopK when search runs without --top-k", async () => {
    const root = await tempWorkspace();
    const workspace = path.join(root, ".kb");
    process.env.QLI_HOME = path.join(root, ".qli-home");

    await runCli(["init", "--workspace", workspace]);
    await writeFile(path.join(workspace, "config.yaml"), "retrieval:\n  dense:\n    enabled: false\n  sparse:\n    enabled: false\nsearch:\n  defaultTopK: 1\n", "utf8");
    await runCli([
      "source",
      "add",
      "directory",
      path.resolve("test-fixtures/docs"),
      "--workspace",
      workspace,
      "--name",
      "Local Docs",
      "--tag",
      "docs"
    ]);
    await runCli(["rebuild", "--workspace", workspace]);

    const search = await runCli(["search", "api", "--workspace", workspace, "--json"]);
    const parsed = JSON.parse(search.stdout);

    expect(search.exitCode).toBe(0);
    expect(parsed.ok).toBe(true);
    expect(parsed.data.hits.hits).toHaveLength(1);
  });

  it("rebuild auto-builds dense vectors when the model is already available", async () => {
    const root = await tempWorkspace();
    const workspace = path.join(root, ".kb");
    process.env.QLI_HOME = path.join(root, ".qli-home");
    setDenseEmbedderFactoryForTests(async () => async () => [1, 1, 1]);

    await runCli(["init", "--workspace", workspace]);
    await writeFile(path.join(workspace, "config.yaml"), "retrieval:\n  dense:\n    enabled: true\n  sparse:\n    enabled: false\n", "utf8");
    await writeDensePullMarker(workspace, {
      modelId: "Xenova/paraphrase-MiniLM-L3-v2",
      cacheDir: "~/.qli/models/huggingface"
    }, { pulledAt: "2026-05-18T00:00:00.000Z" });
    await runCli([
      "source",
      "add",
      "directory",
      path.resolve("test-fixtures/docs"),
      "--workspace",
      workspace,
      "--name",
      "Local Docs",
      "--tag",
      "docs"
    ]);

    const rebuild = await runCli(["rebuild", "--workspace", workspace, "--json"]);
    const parsed = JSON.parse(rebuild.stdout);

    expect(rebuild.exitCode).toBe(0);
    expect(parsed.ok).toBe(true);
    await expect(import("node:fs/promises").then((fs) => fs.stat(denseVectorPath(workspace)))).resolves.toBeDefined();
  });

  it("init pulls missing retrieval models for enabled modes", async () => {
    const root = await tempWorkspace();
    const workspace = path.join(root, ".kb");
    process.env.QLI_HOME = path.join(root, ".qli-home");

    const pulls: Array<{ pullDense: boolean; pullSparse: boolean; workspacePath: string }> = [];
    setPullModelsForTests(async ({ workspacePath, pullDense, pullSparse }) => {
      pulls.push({ workspacePath, pullDense, pullSparse });
    });

    const init = await runCli(["init", "--workspace", workspace, "--json"]);
    const parsed = JSON.parse(init.stdout);

    expect(init.exitCode).toBe(0);
    expect(parsed.ok).toBe(true);
    expect(pulls).toHaveLength(1);
    expect(pulls[0]?.workspacePath).toBe(workspace);
    expect(pulls[0]?.pullDense).toBe(true);
  });

  it("prints progress by default and suppresses it with --silent", async () => {
    const root = await tempWorkspace();
    const workspace = path.join(root, ".kb");
    process.env.QLI_HOME = path.join(root, ".qli-home");

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
      "Local Docs"
    ]);

    const ingest = await runCli(["ingest", "--workspace", workspace]);
    expect(ingest.exitCode).toBe(0);
    expect(ingest.stdout).toContain("Processed 1 sources");
    expect(ingest.stderr).toContain("Ingest step 1/3: fetch and normalize");
    expect(ingest.stderr).toContain("Ingest step 2/3: chunk affected documents");
    expect(ingest.stderr).toContain("Ingest step 3/3: refresh index");
    expect(ingest.stderr).toContain("Ingesting 1 source");
    expect(ingest.stderr).toContain("Source Local Docs (directory)");
    expect(ingest.stderr).toContain("Scanning ");
    expect(ingest.stderr).toContain("Reading file");
    expect(ingest.stderr).toContain("Added ");
    expect(ingest.stderr).toContain("Finished Local Docs:");
    expect(ingest.stderr).toContain("Chunking complete:");
    expect(ingest.stderr).toContain("Index build complete:");

    const ingestSilent = await runCli(["ingest", "--workspace", workspace, "--silent"]);
    expect(ingestSilent.exitCode).toBe(0);
    expect(ingestSilent.stdout).toContain("Processed 1 sources");
    expect(ingestSilent.stderr).toBe("");

    const rebuild = await runCli(["rebuild", "--workspace", workspace]);
    expect(rebuild.exitCode).toBe(0);
    expect(rebuild.stdout).toContain("Processed 1 sources");
    expect(rebuild.stderr).toContain("Rebuild step 1/3: ingest");
    expect(rebuild.stderr).toContain("Scanning ");
    expect(rebuild.stderr).toContain("Reading file");
    expect(rebuild.stderr).toContain("Unchanged ");
    expect(rebuild.stderr).toContain("Finished Local Docs:");
    expect(rebuild.stderr).toContain("Rebuild complete");

    const silent = await runCli(["rebuild", "--workspace", workspace, "--silent"]);
    expect(silent.exitCode).toBe(0);
    expect(silent.stdout).toContain("Processed 1 sources");
    expect(silent.stderr).toBe("");
  });

  it("streams ingest progress through stderr callbacks before the command completes", async () => {
    const root = await tempWorkspace();
    const workspace = path.join(root, ".kb");
    process.env.QLI_HOME = path.join(root, ".qli-home");

    await runCli(["init", "--workspace", workspace]);
    await writeFile(path.join(workspace, "config.yaml"), "retrieval:\n  dense:\n    enabled: false\n  sparse:\n    enabled: false\n", "utf8");

    vi.stubGlobal("fetch", vi.fn(async () => {
      await new Promise((resolve) => setTimeout(resolve, 100));
      return new Response("<html><head><title>Delayed Page</title></head><body><h1>Delayed Page</h1><p>content</p></body></html>", {
        status: 200,
        headers: { "content-type": "text/html" }
      });
    }));

    await runCli([
      "source",
      "add",
      "page",
      "https://example.com/delayed",
      "--workspace",
      workspace,
      "--name",
      "Delayed Page"
    ]);

    const streamed: string[] = [];
    const ingestPromise = runCli(["ingest", "--workspace", workspace], {
      onStderr(value) {
        streamed.push(value);
      }
    });

    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(streamed).toContain("Ingest step 1/3: fetch and normalize");
    expect(streamed).toContain("Ingesting 1 source");

    const ingest = await ingestPromise;
    expect(ingest.exitCode).toBe(0);
    expect(streamed).toEqual(ingest.stderr.split("\n"));
  });

  it("streams crawl discovery progress before website crawling finishes", async () => {
    const root = await tempWorkspace();
    const workspace = path.join(root, ".kb");
    process.env.QLI_HOME = path.join(root, ".qli-home");

    await runCli(["init", "--workspace", workspace]);
    await writeFile(path.join(workspace, "config.yaml"), "retrieval:\n  dense:\n    enabled: false\n  sparse:\n    enabled: false\ncrawler:\n  maxConcurrentRequests: 1\n", "utf8");

    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "https://example.com/robots.txt" || url === "https://example.com/sitemap.xml") {
        await new Promise((resolve) => setTimeout(resolve, 10));
        return new Response("not found", { status: 404 });
      }
      if (url === "https://example.com/") {
        await new Promise((resolve) => setTimeout(resolve, 100));
        return new Response("<html><body><a href=\"/one\">One</a><a href=\"/two\">Two</a></body></html>", {
          status: 200,
          headers: { "content-type": "text/html" }
        });
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
      return new Response(`<html><head><title>${url}</title></head><body><h1>${url}</h1></body></html>`, {
        status: 200,
        headers: { "content-type": "text/html" }
      });
    }));

    await runCli([
      "source",
      "add",
      "website",
      "https://example.com/",
      "--workspace",
      workspace,
      "--name",
      "Example Site",
      "--max-depth",
      "1",
      "--max-concurrent-requests",
      "1"
    ]);

    const streamed: string[] = [];
    const ingestPromise = runCli(["ingest", "--workspace", workspace], {
      onStderr(value) {
        streamed.push(value);
      }
    });

    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(streamed).toContain("Crawling https://example.com/");
    expect(streamed).toContain("Discovered 0 sitemap URLs for https://example.com/");
    expect(streamed).toContain("Crawl depth 0: evaluating 1 candidate URL");
    expect(streamed).toContain("Discovered https://example.com/");

    const ingest = await ingestPromise;
    expect(ingest.exitCode).toBe(0);
    expect(streamed.some((line) => line.startsWith("Fetched "))).toBe(true);
  });

  it("search works after ingest without a separate rebuild", async () => {
    const root = await tempWorkspace();
    const workspace = path.join(root, ".kb");
    process.env.QLI_HOME = path.join(root, ".qli-home");

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
      "Local Docs"
    ]);
    await runCli(["ingest", "--workspace", workspace]);

    const search = await runCli(["search", "authentication", "--workspace", workspace, "--json"]);
    const parsed = JSON.parse(search.stdout);

    expect(search.exitCode).toBe(0);
    expect(parsed.ok).toBe(true);
    expect(parsed.data.hits.hits.length).toBeGreaterThan(0);
  });

  it("returns raw JSON DSL hits through search-json", async () => {
    const root = await tempWorkspace();
    const workspace = path.join(root, ".kb");
    process.env.QLI_HOME = path.join(root, ".qli-home");

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
      "Local Docs"
    ]);
    await runCli(["ingest", "--workspace", workspace]);

    const search = await runCli([
      "search-json",
      "{\"query\":{\"match\":{\"text\":\"authentication\"}},\"size\":3}",
      "--workspace",
      workspace,
      "--json"
    ]);
    const parsed = JSON.parse(search.stdout);

    expect(search.exitCode).toBe(0);
    expect(parsed.ok).toBe(true);
    expect(parsed.command).toBe("search-json");
    expect(parsed.data.hits.hits[0]._source.chunkId).toBeTruthy();
    expect(parsed.data.hits.hits[0]._source.text.toLowerCase()).toContain("authentication");
  });

  it("renders search results with separators and omits heading breadcrumbs", async () => {
    const root = await tempWorkspace();
    const workspace = path.join(root, ".kb");
    process.env.QLI_HOME = path.join(root, ".qli-home");

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
      "Local Docs"
    ]);
    await runCli(["ingest", "--workspace", workspace]);

    const search = await runCli(["search", "authentication", "--workspace", workspace]);
    expect(search.exitCode).toBe(0);
    expect(search.stdout).toContain("1.");
    expect(search.stdout).toContain("API Authentication");
    expect(search.stdout).toContain("URL: ");
    expect(search.stdout).toContain("Source: directory | Published: n/a | Score:");
    expect(search.stdout).not.toContain("Heading Path:");

    const jsonSearch = await runCli(["search", "authentication", "--workspace", workspace, "--json"]);
    const parsed = JSON.parse(jsonSearch.stdout);
    expect(parsed.data.hits.hits[0]._source.headingPath).toBeDefined();
  });
});
