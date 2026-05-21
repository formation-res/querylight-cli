import { mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { readJsonFromGzipOrFile, resolveExistingGzipOrFilePath, writeGzipJson } from "../core/gzip-json.js";
import type { IndexMetadata } from "../types/models.js";

function versionedIndexPath(workspacePath: string, stamp: string): string {
  return path.join(workspacePath, "indexes", `${stamp}.json.gz`);
}

function versionedLegacyIndexPath(workspacePath: string, stamp: string): string {
  return path.join(workspacePath, "indexes", `${stamp}.json`);
}

function versionedMetaPath(workspacePath: string, stamp: string): string {
  return path.join(workspacePath, "indexes", `${stamp}.meta.json.gz`);
}

function versionedLegacyMetaPath(workspacePath: string, stamp: string): string {
  return path.join(workspacePath, "indexes", `${stamp}.meta.json`);
}

export function latestIndexPath(workspacePath: string): string {
  return path.join(workspacePath, "indexes", "latest.json.gz");
}

function legacyLatestIndexPath(workspacePath: string): string {
  return path.join(workspacePath, "indexes", "latest.json");
}

export function latestMetaPath(workspacePath: string): string {
  return path.join(workspacePath, "indexes", "latest.meta.json.gz");
}

function legacyLatestMetaPath(workspacePath: string): string {
  return path.join(workspacePath, "indexes", "latest.meta.json");
}

export async function writeIndexArtifacts(
  {
    workspacePath,
    indexState,
    metadata
  }: {
    workspacePath: string;
    indexState: object;
    metadata: IndexMetadata;
  }
): Promise<{ indexPath: string; metadataPath: string }> {
  const stamp = metadata.createdAt.replace(/[:.]/g, "-");
  const indexPath = versionedIndexPath(workspacePath, stamp);
  const metaPath = versionedMetaPath(workspacePath, stamp);
  const latestIndexArtifactPath = latestIndexPath(workspacePath);
  const latestMetadataArtifactPath = latestMetaPath(workspacePath);
  await mkdir(path.join(workspacePath, "indexes"), { recursive: true });
  await writeGzipJson(indexPath, indexState);
  await writeGzipJson(metaPath, metadata);
  await writeGzipJson(latestIndexArtifactPath, indexState);
  await writeGzipJson(latestMetadataArtifactPath, metadata);
  await Promise.all([
    rm(legacyLatestIndexPath(workspacePath), { force: true }),
    rm(legacyLatestMetaPath(workspacePath), { force: true }),
    rm(versionedLegacyIndexPath(workspacePath, stamp), { force: true }),
    rm(versionedLegacyMetaPath(workspacePath, stamp), { force: true })
  ]);
  return { indexPath: latestIndexArtifactPath, metadataPath: latestMetadataArtifactPath };
}

export async function readLatestIndexState(workspacePath: string): Promise<object> {
  return readJsonFromGzipOrFile<object>(latestIndexPath(workspacePath), legacyLatestIndexPath(workspacePath));
}

export async function readLatestIndexMetadata(workspacePath: string): Promise<IndexMetadata> {
  return readJsonFromGzipOrFile<IndexMetadata>(latestMetaPath(workspacePath), legacyLatestMetaPath(workspacePath));
}

export async function resolveLatestIndexArtifactPath(workspacePath: string): Promise<string> {
  return resolveExistingGzipOrFilePath(latestIndexPath(workspacePath), legacyLatestIndexPath(workspacePath));
}
