import type { DenseVectorPayload, SparseVectorPayload, WorkspaceConfig } from "../types/models.js";
import { reportProgress, type ProgressHandler } from "../core/progress.js";
import { buildDenseVectors, pullDenseModel } from "./dense.js";
import { isUvAvailable } from "./runtime.js";
import { buildSparseVectors, pullSparseModel } from "./sparse.js";
import { buildModelStatus, readDensePayload, readSparsePayload, writeDensePullMarker, writeSparsePullMarker } from "./store.js";

let pullModelsOverrideForTests: ((args: {
  workspacePath: string;
  config: WorkspaceConfig;
  pullDense: boolean;
  pullSparse: boolean;
  progress?: ProgressHandler;
}) => Promise<void>) | null = null;

export function setPullModelsForTests(
  override: ((args: {
    workspacePath: string;
    config: WorkspaceConfig;
    pullDense: boolean;
    pullSparse: boolean;
    progress?: ProgressHandler;
  }) => Promise<void>) | null
): void {
  pullModelsOverrideForTests = override;
}

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

export function resolveMissingConfiguredModelPullPlan(
  {
    config,
    status
  }: {
    config: WorkspaceConfig;
    status: Awaited<ReturnType<typeof buildModelStatus>>;
  }
): { pullDense: boolean; pullSparse: boolean } {
  return {
    pullDense: config.retrieval.dense.enabled && !status.dense.available,
    pullSparse: config.retrieval.sparse.enabled && status.sparse.uvAvailable && !status.sparse.available
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
  const uvAvailable = await isUvAvailable();
  const modelStatus = buildAvailableModels
    ? await buildModelStatus(workspacePath, config.retrieval.dense, config.retrieval.sparse, uvAvailable)
    : null;
  const denseEnabled = denseOverride ?? (buildAvailableModels
    ? (config.retrieval.dense.enabled || Boolean(modelStatus?.dense.available))
    : config.retrieval.dense.enabled);
  const sparseEnabled = sparseOverride ?? (buildAvailableModels
    ? ((config.retrieval.sparse.enabled || Boolean(modelStatus?.sparse.available)) && Boolean(modelStatus?.sparse.uvAvailable))
    : (config.retrieval.sparse.enabled && uvAvailable));
  const result: { dense?: DenseVectorPayload; sparse?: SparseVectorPayload } = {};
  if (denseEnabled) {
    reportProgress(progress, `Building dense vectors with ${config.retrieval.dense.modelId}`);
    result.dense = await buildDenseVectors({ workspacePath, config: config.retrieval.dense, progress });
  }
  if ((sparseOverride || config.retrieval.sparse.enabled) && !uvAvailable) {
    reportProgress(progress, "Skipping sparse vectors because uv is not available");
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
  if (pullModelsOverrideForTests) {
    await pullModelsOverrideForTests({ workspacePath, config, pullDense, pullSparse, progress });
    return;
  }
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
  const uvAvailable = await isUvAvailable();
  return buildModelStatus(workspacePath, config.retrieval.dense, config.retrieval.sparse, uvAvailable);
}
