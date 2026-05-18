import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ensureWorkspace } from "../src/core/workspace.js";
import { writeJsonl } from "../src/core/jsonl.js";
import { diffWorkspace } from "../src/report/diff-service.js";
import { runCli } from "../src/cli/run-cli.js";
import { addSource } from "../src/sources/source-store.js";
import { ingestSources } from "../src/ingest/ingest-service.js";
import { tempWorkspace, cleanupTempDirs } from "./helpers.js";

afterEach(async () => {
  await cleanupTempDirs();
});

describe("targeted regressions", () => {
  it("doctor does not create a missing workspace", async () => {
    const root = await tempWorkspace("qli-doctor-");
    const workspace = path.join(root, "missing-kb");

    const result = await runCli(["doctor", "--workspace", workspace, "--json"]);
    expect(result.exitCode).toBe(3);
    const parsed = JSON.parse(result.stderr);
    expect(parsed.error.code).toBe("WORKSPACE_ERROR");
  });

  it("source add rejects unsupported source types", async () => {
    const root = await tempWorkspace("qli-type-");
    const workspace = path.join(root, ".kb");
    await runCli(["init", "--workspace", workspace]);

    const result = await runCli([
      "source",
      "add",
      "banana",
      "abc",
      "--workspace",
      workspace,
      "--name",
      "Bad",
      "--json"
    ]);

    expect(result.exitCode).toBe(2);
    const parsed = JSON.parse(result.stderr);
    expect(parsed.error.code).toBe("INVALID_ARGUMENT");
  });

  it("diff since compares against the most recent run before the timestamp", async () => {
    const root = await tempWorkspace("qli-diff-");
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
    await writeJsonl(path.join(workspacePath, "runs", "2026-05-10.json"), [
      {
        id: "2026-05-10",
        kind: "ingest",
        createdAt: "2026-05-10T00:00:00.000Z",
        success: true,
        summary: {},
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
    await writeJsonl(path.join(workspacePath, "runs", "2026-05-20.json"), [
      {
        id: "2026-05-20",
        kind: "ingest",
        createdAt: "2026-05-20T00:00:00.000Z",
        success: true,
        summary: {},
        documentsSnapshot: [
          {
            id: "doc1",
            title: "Doc 1",
            uri: "file:///doc1.md",
            contentHash: "hash-new",
            lastChangedAt: "2026-05-18T00:00:00.000Z",
            sourceId: "src1"
          }
        ]
      }
    ]);

    const diff = await diffWorkspace({ workspacePath, since: "2026-05-15T00:00:00.000Z" });
    expect(diff.changedDocuments).toHaveLength(1);
    expect(diff.changedDocuments[0]?.previousHash).toBe("hash-old");
  });

  it("ingestion run records include failure details", async () => {
    const root = await tempWorkspace("qli-fail-");
    const { workspacePath } = await ensureWorkspace({ workspacePath: path.join(root, ".kb") });
    const missingFile = path.join(root, "missing.md");
    const source = await addSource(workspacePath, {
      type: "file",
      uri: missingFile,
      name: "Missing",
      enabled: true,
      tags: [],
      metadata: {},
      createdAt: "2026-05-18T00:00:00.000Z",
      updatedAt: "2026-05-18T00:00:00.000Z"
    });

    const result = await ingestSources({ workspacePath, sourceIds: [source.id] });
    expect(result.documents.failed).toBe(1);

    const runsDir = path.join(workspacePath, "runs");
    const entries = await import("node:fs/promises").then((fs) => fs.readdir(runsDir));
    const runBody = await readFile(path.join(runsDir, entries[0]!), "utf8");
    expect(runBody).toContain("failures");
    expect(runBody).toContain("ENOENT");
  });
});
