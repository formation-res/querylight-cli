import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ensureWorkspace } from "../src/core/workspace.js";
import { runCli } from "../src/cli/run-cli.js";
import { loadConfig } from "../src/core/config.js";
import { resolveMissingConfiguredModelPullPlan, resolveModelPullPlan } from "../src/vector/service.js";
import { buildModelStatus } from "../src/vector/store.js";
import { writeDensePullMarker, writeSparsePullMarker } from "../src/vector/store.js";
import { cleanupTempDirs, tempWorkspace } from "./helpers.js";

afterEach(async () => {
  delete process.env.QLI_HOME;
  await cleanupTempDirs();
});

describe("model commands", () => {
  it("pulls all available models by default", () => {
    expect(resolveModelPullPlan({
      pullDenseFlag: false,
      pullSparseFlag: false,
      uvAvailable: true
    })).toEqual({
      pullDense: true,
      pullSparse: true
    });

    expect(resolveModelPullPlan({
      pullDenseFlag: false,
      pullSparseFlag: false,
      uvAvailable: false
    })).toEqual({
      pullDense: true,
      pullSparse: false
    });
  });

  it("keeps explicit pull flags strict", () => {
    expect(resolveModelPullPlan({
      pullDenseFlag: false,
      pullSparseFlag: true,
      uvAvailable: false
    })).toEqual({
      pullDense: false,
      pullSparse: true
    });
  });

  it("pulls missing configured models only", async () => {
    const root = await tempWorkspace("qli-models-");
    const workspace = path.join(root, ".kb");
    process.env.QLI_HOME = path.join(root, ".qli-home");
    await ensureWorkspace({ workspacePath: workspace });
    const config = await loadConfig(workspace);

    const missingStatus = await buildModelStatus(workspace, config.retrieval.dense, config.retrieval.sparse, false);
    expect(resolveMissingConfiguredModelPullPlan({ config, status: missingStatus })).toEqual({
      pullDense: true,
      pullSparse: false
    });

    await writeDensePullMarker(workspace, config.retrieval.dense, { pulledAt: "2026-05-18T00:00:00.000Z" });
    await writeSparsePullMarker(workspace, config.retrieval.sparse, { pulledAt: "2026-05-18T00:00:00.000Z" });
    const availableStatus = await buildModelStatus(workspace, config.retrieval.dense, config.retrieval.sparse, true);
    expect(resolveMissingConfiguredModelPullPlan({ config, status: availableStatus })).toEqual({
      pullDense: false,
      pullSparse: false
    });
  });

  it("reports model status with artifact and runtime fields", async () => {
    const root = await tempWorkspace("qli-models-");
    const workspace = path.join(root, ".kb");
    process.env.QLI_HOME = path.join(root, ".qli-home");
    await ensureWorkspace({ workspacePath: workspace });
    await writeDensePullMarker(workspace, {
      modelId: "Xenova/all-MiniLM-L6-v2",
      cacheDir: "~/.qli/models/huggingface"
    }, { pulledAt: "2026-05-18T00:00:00.000Z" });
    await writeSparsePullMarker(workspace, {
      modelId: "opensearch-project/opensearch-neural-sparse-encoding-doc-v3-distill",
      cacheDir: "~/.qli/models/huggingface"
    }, { pulledAt: "2026-05-18T00:00:00.000Z" });

    const result = await runCli(["models", "status", "--workspace", workspace, "--json"]);
    expect(result.exitCode).toBe(0);
    const parsed = JSON.parse(result.stdout);
    expect(parsed.data.dense.modelId).toBe("Xenova/all-MiniLM-L6-v2");
    expect(parsed.data.dense.available).toBe(true);
    expect(parsed.data.dense.cacheDir).toBe(path.join(root, ".qli-home", "models", "huggingface"));
    expect(typeof parsed.data.sparse.uvAvailable).toBe("boolean");
  });
});
