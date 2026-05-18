import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ensureWorkspace } from "../src/core/workspace.js";
import { runCli } from "../src/cli/run-cli.js";
import { writeDensePullMarker, writeSparsePullMarker } from "../src/vector/store.js";
import { cleanupTempDirs, tempWorkspace } from "./helpers.js";

afterEach(async () => {
  await cleanupTempDirs();
});

describe("model commands", () => {
  it("reports model status with artifact and runtime fields", async () => {
    const root = await tempWorkspace("qli-models-");
    const workspace = path.join(root, ".kb");
    await ensureWorkspace({ workspacePath: workspace });
    await writeDensePullMarker(workspace, { pulledAt: "2026-05-18T00:00:00.000Z" });
    await writeSparsePullMarker(workspace, { pulledAt: "2026-05-18T00:00:00.000Z" });

    const result = await runCli(["models", "status", "--workspace", workspace, "--json"]);
    expect(result.exitCode).toBe(0);
    const parsed = JSON.parse(result.stdout);
    expect(parsed.data.dense.modelId).toBe("Xenova/all-MiniLM-L6-v2");
    expect(parsed.data.dense.available).toBe(true);
    expect(typeof parsed.data.sparse.uvAvailable).toBe("boolean");
  });
});
