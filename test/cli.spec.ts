import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runCli } from "../src/cli/run-cli.js";

const tempDirs: string[] = [];

async function tempWorkspace(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "qli-cli-test-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
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
});
