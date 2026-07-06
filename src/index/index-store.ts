import { cp, mkdir, readdir, rm, stat } from "node:fs/promises";
import path from "node:path";
import { readGzipSerialized, readJsonFromGzipOrFile, writeGzipJson, writeGzipSerialized } from "../core/gzip-json.js";
import type { IndexMetadata } from "../types/models.js";

function versionedShardedIndexPath(workspacePath: string, stamp: string): string {
  return path.join(workspacePath, "indexes", `${stamp}.index`);
}

function versionedMetaPath(workspacePath: string, stamp: string): string {
  return path.join(workspacePath, "indexes", `${stamp}.meta.json.gz`);
}

export function latestIndexPath(workspacePath: string): string {
  return path.join(workspacePath, "indexes", "latest.index");
}

export function latestMetaPath(workspacePath: string): string {
  return path.join(workspacePath, "indexes", "latest.meta.json.gz");
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
  const indexPath = versionedShardedIndexPath(workspacePath, stamp);
  const metaPath = versionedMetaPath(workspacePath, stamp);
  const latestIndexArtifactPath = latestIndexPath(workspacePath);
  const latestMetadataArtifactPath = latestMetaPath(workspacePath);
  await mkdir(path.join(workspacePath, "indexes"), { recursive: true });
  await writeShardedIndex(indexPath, indexState);
  await writeGzipJson(metaPath, metadata);
  await rm(latestIndexArtifactPath, { recursive: true, force: true });
  await cp(indexPath, latestIndexArtifactPath, { recursive: true });
  await writeGzipJson(latestMetadataArtifactPath, metadata);
  return { indexPath: latestIndexArtifactPath, metadataPath: latestMetadataArtifactPath };
}

export async function readLatestIndexState(workspacePath: string): Promise<object> {
  return readShardedIndex(latestIndexPath(workspacePath));
}

export async function readLatestIndexMetadata(workspacePath: string): Promise<IndexMetadata> {
  return readJsonFromGzipOrFile<IndexMetadata>(latestMetaPath(workspacePath));
}

export async function resolveLatestIndexArtifactPath(workspacePath: string): Promise<string> {
  return latestIndexPath(workspacePath);
}

type ShardedIndexManifest = {
  format: "querylight-index-shards-v1";
  documents: string;
  fields: Record<string, string>;
};

async function writeShardedIndex(indexPath: string, indexState: object): Promise<void> {
  const state = indexState as { documents?: unknown; fieldState?: Record<string, unknown> };
  const temporaryPath = `${indexPath}.${process.pid}.${Date.now()}.tmp`;
  await rm(temporaryPath, { recursive: true, force: true });
  await mkdir(path.join(temporaryPath, "fields"), { recursive: true });
  const manifest: ShardedIndexManifest = {
    format: "querylight-index-shards-v1",
    documents: "documents.v8.gz",
    fields: {}
  };
  await writeGzipSerialized(path.join(temporaryPath, manifest.documents), state.documents ?? {});
  for (const [field, fieldState] of Object.entries(state.fieldState ?? {})) {
    const fileName = `${Buffer.from(field).toString("base64url")}.v8.gz`;
    const relativePath = path.join("fields", fileName);
    manifest.fields[field] = relativePath;
    await writeGzipSerialized(path.join(temporaryPath, relativePath), flattenFieldStateForStorage(fieldState));
  }
  await writeGzipJson(path.join(temporaryPath, "manifest.json.gz"), manifest);
  await rm(indexPath, { recursive: true, force: true });
  await mkdir(path.dirname(indexPath), { recursive: true });
  await cp(temporaryPath, indexPath, { recursive: true });
  await rm(temporaryPath, { recursive: true, force: true });
}

async function readShardedIndex(indexPath: string): Promise<object> {
  const manifest = await readJsonFromGzipOrFile<ShardedIndexManifest>(path.join(indexPath, "manifest.json.gz"));
  const fieldState: Record<string, unknown> = {};
  for (const [field, relativePath] of Object.entries(manifest.fields)) {
    fieldState[field] = inflateFieldStateFromStorage(await readGzipSerialized(path.join(indexPath, relativePath)));
  }
  return {
    documents: await readGzipSerialized(path.join(indexPath, manifest.documents)),
    fieldState
  };
}

function flattenFieldStateForStorage(fieldState: unknown): unknown {
  if (!fieldState || typeof fieldState !== "object" || (fieldState as { kind?: unknown }).kind !== "TextFieldIndexState") {
    return fieldState;
  }
  const textState = fieldState as { reverseMap?: Record<string, unknown>; [key: string]: unknown };
  return {
    ...textState,
    trie: { children: {}, isLeaf: false },
    trieTerms: Object.keys(textState.reverseMap ?? {})
  };
}

function inflateFieldStateFromStorage(fieldState: unknown): unknown {
  if (!fieldState || typeof fieldState !== "object" || (fieldState as { kind?: unknown }).kind !== "TextFieldIndexState") {
    return fieldState;
  }
  const textState = fieldState as { trieTerms?: unknown; [key: string]: unknown };
  if (!Array.isArray(textState.trieTerms)) {
    return fieldState;
  }
  const { trieTerms, ...rest } = textState;
  return {
    ...rest,
    trie: trieStateFromTerms(trieTerms.map(String))
  };
}

type StoredTrieNode = { children: Record<string, StoredTrieNode>; isLeaf: boolean };

function trieStateFromTerms(terms: string[]): StoredTrieNode {
  const root: StoredTrieNode = { children: {}, isLeaf: false };
  for (const term of terms) {
    let node = root;
    for (const char of term) {
      node.children[char] ??= { children: {}, isLeaf: false };
      node = node.children[char];
    }
    node.isLeaf = true;
  }
  return root;
}

export async function artifactSizeBytes(filePath: string): Promise<number> {
  const info = await stat(filePath);
  if (!info.isDirectory()) {
    return info.size;
  }
  const entries = await readdir(filePath, { withFileTypes: true });
  const sizes = await Promise.all(entries.map((entry) => artifactSizeBytes(path.join(filePath, entry.name))));
  return sizes.reduce((total, size) => total + size, 0);
}
