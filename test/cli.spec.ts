import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runCli } from "../src/cli/run-cli.js";
import { setDenseEmbedderFactoryForTests } from "../src/vector/dense.js";
import { denseVectorPath, writeDensePullMarker } from "../src/vector/store.js";

const tempDirs: string[] = [];

async function tempWorkspace(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "qli-cli-test-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  setDenseEmbedderFactoryForTests(null);
  await Promise.all(tempDirs.splice(0).map(async (dir) => {
    await import("node:fs/promises").then((fs) => fs.rm(dir, { recursive: true, force: true }));
  }));
});

describe("cli json output", () => {
  it("returns stable command envelopes", async () => {
    const root = await tempWorkspace();
    const workspace = path.join(root, ".kb");
    const init = await runCli(["init", "--workspace", workspace, "--json"]);
    const initParsed = JSON.parse(init.stdout);

    expect(init.exitCode).toBe(0);
    expect(initParsed.ok).toBe(true);
    expect(initParsed.command).toBe("init");

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

    const rebuild = await runCli(["rebuild", "--workspace", workspace, "--json"]);
    const rebuildParsed = JSON.parse(rebuild.stdout);
    expect(rebuildParsed.ok).toBe(true);
    expect(rebuildParsed.data.indexPath).toContain("indexes");

    const search = await runCli(["search", "authentication", "--workspace", workspace, "--json"]);
    const searchParsed = JSON.parse(search.stdout);
    expect(searchParsed.ok).toBe(true);
    expect(searchParsed.data.results[0].title).toContain("API Authentication");
  });

  it("returns related documents from the CLI", async () => {
    const root = await tempWorkspace();
    const workspace = path.join(root, ".kb");
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
    await writeFile(path.join(workspace, "config.yaml"), "retrieval:\n  dense:\n    enabled: true\n", "utf8");
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

  it("rebuild auto-builds dense vectors when the model is already available", async () => {
    const root = await tempWorkspace();
    const workspace = path.join(root, ".kb");
    setDenseEmbedderFactoryForTests(async () => async () => [1, 1, 1]);

    await runCli(["init", "--workspace", workspace]);
    await writeDensePullMarker(workspace, { pulledAt: "2026-05-18T00:00:00.000Z" });
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

  it("prints progress by default and suppresses it with --silent", async () => {
    const root = await tempWorkspace();
    const workspace = path.join(root, ".kb");

    await runCli(["init", "--workspace", workspace]);
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

    const rebuild = await runCli(["rebuild", "--workspace", workspace]);
    expect(rebuild.exitCode).toBe(0);
    expect(rebuild.stdout).toContain("Processed 1 sources");
    expect(rebuild.stderr).toContain("Rebuild step 1/3: ingest");
    expect(rebuild.stderr).toContain("Rebuild complete");

    const silent = await runCli(["rebuild", "--workspace", workspace, "--silent"]);
    expect(silent.exitCode).toBe(0);
    expect(silent.stdout).toContain("Processed 1 sources");
    expect(silent.stderr).toBe("");
  });
});
