import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type { DenseVectorPayload, ModelStatusResponse, SparseVectorPayload } from "../types/models.js";
import { fileExists } from "../core/files.js";
import { readJsonFromGzipOrFile, writeGzipJson } from "../core/gzip-json.js";
import { sha256 } from "../core/hashing.js";
import { resolveCacheDir, resolveQliHomeDir } from "./runtime.js";

function vectorsDir(workspacePath: string): string {
  return path.join(workspacePath, "vectors");
}

function sharedModelStateDir(): string {
  return path.join(resolveQliHomeDir(), "models", "status");
}

export function denseVectorPath(workspacePath: string): string {
  return path.join(vectorsDir(workspacePath), "dense.latest.json.gz");
}

export function denseMetaPath(workspacePath: string): string {
  return path.join(vectorsDir(workspacePath), "dense.latest.meta.json.gz");
}

export function sparseVectorPath(workspacePath: string): string {
  return path.join(vectorsDir(workspacePath), "sparse.latest.json.gz");
}

export function sparseMetaPath(workspacePath: string): string {
  return path.join(vectorsDir(workspacePath), "sparse.latest.meta.json.gz");
}

function legacyDenseVectorPath(workspacePath: string): string {
  return path.join(vectorsDir(workspacePath), "dense.latest.json");
}

function legacyDenseMetaPath(workspacePath: string): string {
  return path.join(vectorsDir(workspacePath), "dense.latest.meta.json");
}

function legacySparseVectorPath(workspacePath: string): string {
  return path.join(vectorsDir(workspacePath), "sparse.latest.json");
}

function legacySparseMetaPath(workspacePath: string): string {
  return path.join(vectorsDir(workspacePath), "sparse.latest.meta.json");
}

function pullMarkerPath(
  type: "dense" | "sparse",
  workspacePath: string,
  modelId: string,
  cacheDir: string
): string {
  const resolvedCacheDir = resolveCacheDir(workspacePath, cacheDir);
  const cacheKey = sha256(resolvedCacheDir).slice(0, 16);
  return path.join(sharedModelStateDir(), type, `${encodeURIComponent(modelId)}.${cacheKey}.json`);
}

function densePullMarker(workspacePath: string, modelId: string, cacheDir: string): string {
  return pullMarkerPath("dense", workspacePath, modelId, cacheDir);
}

function sparsePullMarker(workspacePath: string, modelId: string, cacheDir: string): string {
  return pullMarkerPath("sparse", workspacePath, modelId, cacheDir);
}

export async function writeDensePayload(workspacePath: string, payload: DenseVectorPayload): Promise<void> {
  await mkdir(vectorsDir(workspacePath), { recursive: true });
  await writeGzipJson(denseVectorPath(workspacePath), payload);
  await writeGzipJson(denseMetaPath(workspacePath), payload.metadata);
  await Promise.all([
    rm(legacyDenseVectorPath(workspacePath), { force: true }),
    rm(legacyDenseMetaPath(workspacePath), { force: true })
  ]);
}

export async function readDensePayload(workspacePath: string): Promise<DenseVectorPayload> {
  return readJsonFromGzipOrFile<DenseVectorPayload>(denseVectorPath(workspacePath), legacyDenseVectorPath(workspacePath));
}

export async function writeSparsePayload(workspacePath: string, payload: SparseVectorPayload): Promise<void> {
  await mkdir(vectorsDir(workspacePath), { recursive: true });
  await writeGzipJson(sparseVectorPath(workspacePath), payload);
  await writeGzipJson(sparseMetaPath(workspacePath), payload.metadata);
  await Promise.all([
    rm(legacySparseVectorPath(workspacePath), { force: true }),
    rm(legacySparseMetaPath(workspacePath), { force: true })
  ]);
}

export async function readSparsePayload(workspacePath: string): Promise<SparseVectorPayload> {
  return readJsonFromGzipOrFile<SparseVectorPayload>(sparseVectorPath(workspacePath), legacySparseVectorPath(workspacePath));
}

export async function writeDensePullMarker(
  workspacePath: string,
  model: { modelId: string; cacheDir: string },
  value: object
): Promise<void> {
  const markerPath = densePullMarker(workspacePath, model.modelId, model.cacheDir);
  await mkdir(path.dirname(markerPath), { recursive: true });
  await writeFile(markerPath, JSON.stringify(value, null, 2), "utf8");
}

export async function writeSparsePullMarker(
  workspacePath: string,
  model: { modelId: string; cacheDir: string },
  value: object
): Promise<void> {
  const markerPath = sparsePullMarker(workspacePath, model.modelId, model.cacheDir);
  await mkdir(path.dirname(markerPath), { recursive: true });
  await writeFile(markerPath, JSON.stringify(value, null, 2), "utf8");
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
      available: await fileExists(densePullMarker(workspacePath, dense.modelId, dense.cacheDir)),
      artifactExists: await fileExists(denseVectorPath(workspacePath)) || await fileExists(legacyDenseVectorPath(workspacePath))
    },
    sparse: {
      configured: sparse.enabled,
      modelId: sparse.modelId,
      cacheDir: sparseCacheDir,
      uvAvailable,
      available: await fileExists(sparsePullMarker(workspacePath, sparse.modelId, sparse.cacheDir)),
      artifactExists: await fileExists(sparseVectorPath(workspacePath)) || await fileExists(legacySparseVectorPath(workspacePath))
    }
  };
}
