import type { DenseVectorPayload, SparseVectorPayload, WorkspaceConfig } from "../types/models.js";
import { buildDenseVectors, pullDenseModel } from "./dense.js";
import { ensureUvAvailable } from "./runtime.js";
import { buildSparseVectors, pullSparseModel } from "./sparse.js";
import { buildModelStatus, readDensePayload, readSparsePayload, writeDensePullMarker, writeSparsePullMarker } from "./store.js";

export async function buildVectorArtifacts(
  {
    workspacePath,
    config,
    denseOverride,
    sparseOverride
  }: {
    workspacePath: string;
    config: WorkspaceConfig;
    denseOverride?: boolean;
    sparseOverride?: boolean;
  }
): Promise<{ dense?: DenseVectorPayload; sparse?: SparseVectorPayload }> {
  const denseEnabled = denseOverride ?? config.retrieval.dense.enabled;
  const sparseEnabled = sparseOverride ?? config.retrieval.sparse.enabled;
  const result: { dense?: DenseVectorPayload; sparse?: SparseVectorPayload } = {};
  if (denseEnabled) {
    result.dense = await buildDenseVectors({ workspacePath, config: config.retrieval.dense });
  }
  if (sparseEnabled) {
    result.sparse = await buildSparseVectors({ workspacePath, config: config.retrieval.sparse });
  }
  return result;
}

export async function pullModels(
  {
    workspacePath,
    config,
    pullDense,
    pullSparse
  }: {
    workspacePath: string;
    config: WorkspaceConfig;
    pullDense: boolean;
    pullSparse: boolean;
  }
): Promise<void> {
  if (pullDense) {
    await pullDenseModel(workspacePath, config.retrieval.dense);
    await writeDensePullMarker(workspacePath, {
      pulledAt: new Date().toISOString(),
      modelId: config.retrieval.dense.modelId
    });
  }
  if (pullSparse) {
    await pullSparseModel(workspacePath, config.retrieval.sparse);
    await writeSparsePullMarker(workspacePath, {
      pulledAt: new Date().toISOString(),
      modelId: config.retrieval.sparse.modelId
    });
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
