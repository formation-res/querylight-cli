import type { DenseVectorPayload, SparseVectorPayload, WorkspaceConfig } from "../types/models.js";
import { reportProgress, type ProgressHandler } from "../core/progress.js";
import { buildDenseVectors, pullDenseModel } from "./dense.js";
import { ensureUvAvailable } from "./runtime.js";
import { buildSparseVectors, pullSparseModel } from "./sparse.js";
import { buildModelStatus, readDensePayload, readSparsePayload, writeDensePullMarker, writeSparsePullMarker } from "./store.js";

export function resolveModelPullPlan(
  {
    pullDenseFlag,
    pullSparseFlag,
    uvAvailable
  }: {
    pullDenseFlag: boolean;
    pullSparseFlag: boolean;
    uvAvailable: boolean;
  }
): { pullDense: boolean; pullSparse: boolean } {
  if (pullDenseFlag || pullSparseFlag) {
    return {
      pullDense: pullDenseFlag,
      pullSparse: pullSparseFlag
    };
  }
  return {
    pullDense: true,
    pullSparse: uvAvailable
  };
}

export async function buildVectorArtifacts(
  {
    workspacePath,
    config,
    denseOverride,
    sparseOverride,
    buildAvailableModels = false,
    progress
  }: {
    workspacePath: string;
    config: WorkspaceConfig;
    denseOverride?: boolean;
    sparseOverride?: boolean;
    buildAvailableModels?: boolean;
    progress?: ProgressHandler;
  }
): Promise<{ dense?: DenseVectorPayload; sparse?: SparseVectorPayload }> {
  const modelStatus = buildAvailableModels
    ? await buildModelStatus(workspacePath, config.retrieval.dense, config.retrieval.sparse, await (async () => {
        try {
          await ensureUvAvailable();
          return true;
        } catch {
          return false;
        }
      })())
    : null;
  const denseEnabled = denseOverride ?? (buildAvailableModels
    ? (config.retrieval.dense.enabled || Boolean(modelStatus?.dense.available))
    : config.retrieval.dense.enabled);
  const sparseEnabled = sparseOverride ?? (buildAvailableModels
    ? ((config.retrieval.sparse.enabled || Boolean(modelStatus?.sparse.available)) && Boolean(modelStatus?.sparse.uvAvailable))
    : config.retrieval.sparse.enabled);
  const result: { dense?: DenseVectorPayload; sparse?: SparseVectorPayload } = {};
  if (denseEnabled) {
    reportProgress(progress, `Building dense vectors with ${config.retrieval.dense.modelId}`);
    result.dense = await buildDenseVectors({ workspacePath, config: config.retrieval.dense, progress });
  }
  if (sparseEnabled) {
    reportProgress(progress, `Building sparse vectors with ${config.retrieval.sparse.modelId}`);
    result.sparse = await buildSparseVectors({ workspacePath, config: config.retrieval.sparse, progress });
  }
  return result;
}

export async function pullModels(
  {
    workspacePath,
    config,
    pullDense,
    pullSparse,
    progress
  }: {
    workspacePath: string;
    config: WorkspaceConfig;
    pullDense: boolean;
    pullSparse: boolean;
    progress?: ProgressHandler;
  }
): Promise<void> {
  if (pullDense) {
    reportProgress(progress, `Pulling dense model ${config.retrieval.dense.modelId}`);
    await pullDenseModel(workspacePath, config.retrieval.dense);
    await writeDensePullMarker(workspacePath, config.retrieval.dense, {
      pulledAt: new Date().toISOString(),
      modelId: config.retrieval.dense.modelId,
      cacheDir: config.retrieval.dense.cacheDir
    });
    reportProgress(progress, `Dense model ready: ${config.retrieval.dense.modelId}`);
  }
  if (pullSparse) {
    reportProgress(progress, `Pulling sparse model ${config.retrieval.sparse.modelId}`);
    await pullSparseModel(workspacePath, config.retrieval.sparse);
    await writeSparsePullMarker(workspacePath, config.retrieval.sparse, {
      pulledAt: new Date().toISOString(),
      modelId: config.retrieval.sparse.modelId,
      cacheDir: config.retrieval.sparse.cacheDir
    });
    reportProgress(progress, `Sparse model ready: ${config.retrieval.sparse.modelId}`);
  }
}

export async function getModelStatus(workspacePath: string, config: WorkspaceConfig) {
  let uvAvailable = false;
  try {
    await ensureUvAvailable();
    uvAvailable = true;
  } catch {
    uvAvailable = false;
  }
  return buildModelStatus(workspacePath, config.retrieval.dense, config.retrieval.sparse, uvAvailable);
}
