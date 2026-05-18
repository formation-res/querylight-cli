import path from "node:path";
import { readFile } from "node:fs/promises";
import { afterEach, describe, expect, it } from "vitest";
import { runCli } from "../src/cli/run-cli.js";
import { cleanupTempDirs, tempWorkspace } from "./helpers.js";

afterEach(async () => {
  await cleanupTempDirs();
});

describe("cli contracts", () => {
  it("returns structured json errors for invalid metadata arguments", async () => {
    const root = await tempWorkspace("qli-cli-");
    const workspace = path.join(root, ".kb");
    await runCli(["init", "--workspace", workspace]);

    const result = await runCli([
      "source",
      "add",
      "directory",
      path.resolve("test-fixtures/docs"),
      "--workspace",
      workspace,
      "--name",
      "Docs",
      "--metadata",
      "invalid",
      "--json"
    ]);

    expect(result.exitCode).toBe(2);
    const parsed = JSON.parse(result.stderr);
    expect(parsed.ok).toBe(false);
    expect(parsed.error.code).toBe("INVALID_ARGUMENT");
  });

  it("supports source disable and enable through the cli", async () => {
    const root = await tempWorkspace("qli-cli-");
    const workspace = path.join(root, ".kb");
    await runCli(["init", "--workspace", workspace]);
    const added = await runCli([
      "source",
      "add",
      "directory",
      path.resolve("test-fixtures/docs"),
      "--workspace",
      workspace,
      "--name",
      "Docs",
      "--json"
    ]);
    const sourceId = JSON.parse(added.stdout).data.id as string;

    const disabled = await runCli(["source", "disable", sourceId, "--workspace", workspace, "--json"]);
    expect(JSON.parse(disabled.stdout).data.enabled).toBe(false);

    const enabled = await runCli(["source", "enable", sourceId, "--workspace", workspace, "--json"]);
    expect(JSON.parse(enabled.stdout).data.enabled).toBe(true);
  });

  it("stores rss retention per feed and edits it through source config", async () => {
    const root = await tempWorkspace("qli-cli-");
    const workspace = path.join(root, ".kb");
    await runCli(["init", "--workspace", workspace]);

    const added = await runCli([
      "source",
      "add",
      "rss",
      "https://example.com/feed.xml",
      "--workspace",
      workspace,
      "--name",
      "Feed",
      "--json"
    ]);
    const addedParsed = JSON.parse(added.stdout);
    expect(addedParsed.data.crawl.retentionDays).toBe(365);
    expect(addedParsed.data.crawl.fetchArticles).toBe(true);

    const updated = await runCli([
      "source",
      "config",
      addedParsed.data.id,
      "--workspace",
      workspace,
      "--retention-days",
      "30",
      "--metadata",
      "team=docs",
      "--json"
    ]);
    const updatedParsed = JSON.parse(updated.stdout);
    expect(updatedParsed.data.crawl.retentionDays).toBe(30);
    expect(updatedParsed.data.crawl.fetchArticles).toBe(true);
    expect(updatedParsed.data.metadata.team).toBe("docs");

    const stored = await readFile(path.join(workspace, "sources", "sources.jsonl"), "utf8");
    expect(stored).toContain("\"retentionDays\":30");
  });

  it("returns status and doctor json envelopes", async () => {
    const root = await tempWorkspace("qli-cli-");
    const workspace = path.join(root, ".kb");
    await runCli(["init", "--workspace", workspace]);

    const status = await runCli(["status", "--workspace", workspace, "--json"]);
    const statusParsed = JSON.parse(status.stdout);
    expect(statusParsed.ok).toBe(true);
    expect(statusParsed.data.sources).toBe(0);

    const doctor = await runCli(["doctor", "--workspace", workspace, "--json"]);
    const doctorParsed = JSON.parse(doctor.stdout);
    expect(doctorParsed.ok).toBe(true);
    expect(doctorParsed.data.checks).toContain("config parses");
  });
});
