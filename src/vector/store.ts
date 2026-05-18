import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { DenseVectorPayload, ModelStatusResponse, SparseVectorPayload } from "../types/models.js";
import { fileExists } from "../core/files.js";
import { resolveCacheDir } from "./runtime.js";

function vectorsDir(workspacePath: string): string {
  return path.join(workspacePath, "vectors");
}

function modelsDir(workspacePath: string): string {
  return path.join(workspacePath, "models");
}

export function denseVectorPath(workspacePath: string): string {
  return path.join(vectorsDir(workspacePath), "dense.latest.json");
}

export function denseMetaPath(workspacePath: string): string {
  return path.join(vectorsDir(workspacePath), "dense.latest.meta.json");
}

export function sparseVectorPath(workspacePath: string): string {
  return path.join(vectorsDir(workspacePath), "sparse.latest.json");
}

export function sparseMetaPath(workspacePath: string): string {
  return path.join(vectorsDir(workspacePath), "sparse.latest.meta.json");
}

function densePullMarker(workspacePath: string): string {
  return path.join(modelsDir(workspacePath), "dense.pulled.json");
}

function sparsePullMarker(workspacePath: string): string {
  return path.join(modelsDir(workspacePath), "sparse.pulled.json");
}

export async function writeDensePayload(workspacePath: string, payload: DenseVectorPayload): Promise<void> {
  await mkdir(vectorsDir(workspacePath), { recursive: true });
  await writeFile(denseVectorPath(workspacePath), JSON.stringify(payload, null, 2), "utf8");
  await writeFile(denseMetaPath(workspacePath), JSON.stringify(payload.metadata, null, 2), "utf8");
}

export async function readDensePayload(workspacePath: string): Promise<DenseVectorPayload> {
  return JSON.parse(await readFile(denseVectorPath(workspacePath), "utf8")) as DenseVectorPayload;
}

export async function writeSparsePayload(workspacePath: string, payload: SparseVectorPayload): Promise<void> {
  await mkdir(vectorsDir(workspacePath), { recursive: true });
  await writeFile(sparseVectorPath(workspacePath), JSON.stringify(payload, null, 2), "utf8");
  await writeFile(sparseMetaPath(workspacePath), JSON.stringify(payload.metadata, null, 2), "utf8");
}

export async function readSparsePayload(workspacePath: string): Promise<SparseVectorPayload> {
  return JSON.parse(await readFile(sparseVectorPath(workspacePath), "utf8")) as SparseVectorPayload;
}

export async function writeDensePullMarker(workspacePath: string, value: object): Promise<void> {
  await mkdir(modelsDir(workspacePath), { recursive: true });
  await writeFile(densePullMarker(workspacePath), JSON.stringify(value, null, 2), "utf8");
}

export async function writeSparsePullMarker(workspacePath: string, value: object): Promise<void> {
  await mkdir(modelsDir(workspacePath), { recursive: true });
  await writeFile(sparsePullMarker(workspacePath), JSON.stringify(value, null, 2), "utf8");
}

export async function buildModelStatus(
  workspacePath: string,
  dense: { enabled: boolean; modelId: string; cacheDir: string },
  sparse: { enabled: boolean; modelId: string; cacheDir: string },
  uvAvailable: boolean
): Promise<ModelStatusResponse> {
  const denseCacheDir = resolveCacheDir(workspacePath, dense.cacheDir);
  const sparseCacheDir = resolveCacheDir(workspacePath, sparse.cacheDir);
  return {
    dense: {
      configured: dense.enabled,
      modelId: dense.modelId,
      cacheDir: denseCacheDir,
      available: await fileExists(densePullMarker(workspacePath)),
      artifactExists: await fileExists(denseVectorPath(workspacePath))
    },
    sparse: {
      configured: sparse.enabled,
      modelId: sparse.modelId,
      cacheDir: sparseCacheDir,
      uvAvailable,
      available: await fileExists(sparsePullMarker(workspacePath)),
      artifactExists: await fileExists(sparseVectorPath(workspacePath))
    }
  };
}
