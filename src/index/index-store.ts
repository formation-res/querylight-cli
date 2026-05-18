import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { IndexMetadata } from "../types/models.js";

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
  const indexPath = path.join(workspacePath, "indexes", `${stamp}.json`);
  const metaPath = path.join(workspacePath, "indexes", `${stamp}.meta.json`);
  const latestIndexPath = path.join(workspacePath, "indexes", "latest.json");
  const latestMetaPath = path.join(workspacePath, "indexes", "latest.meta.json");
  const indexPayload = JSON.stringify(indexState, null, 2);
  const metaPayload = JSON.stringify(metadata, null, 2);
  await writeFile(indexPath, indexPayload, "utf8");
  await writeFile(metaPath, metaPayload, "utf8");
  await writeFile(latestIndexPath, indexPayload, "utf8");
  await writeFile(latestMetaPath, metaPayload, "utf8");
  return { indexPath: latestIndexPath, metadataPath: latestMetaPath };
}

export async function readLatestIndexState(workspacePath: string): Promise<object> {
  return JSON.parse(await readFile(path.join(workspacePath, "indexes", "latest.json"), "utf8")) as object;
}

export async function readLatestIndexMetadata(workspacePath: string): Promise<IndexMetadata> {
  return JSON.parse(await readFile(path.join(workspacePath, "indexes", "latest.meta.json"), "utf8")) as IndexMetadata;
}
