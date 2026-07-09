import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { resolveStoredWorkspacePath } from "../core/workspace-paths.js";
import type { DocumentRecord, Metadata, PrimitiveMetadata, Source } from "../types/models.js";
import { withFrontmatter } from "../normalize/normalize-markdown.js";

function asMetadataValue(value: PrimitiveMetadata | undefined): PrimitiveMetadata | undefined {
  return value === undefined ? undefined : value;
}

export function buildDocumentMetadata(
  {
    source,
    sourceUri,
    publicationDate,
    crawledAt,
    indexedAt,
    extra = {}
  }: {
    source: Source;
    sourceUri: string;
    publicationDate?: string | null;
    crawledAt?: string;
    indexedAt?: string;
    extra?: Record<string, PrimitiveMetadata | undefined>;
  }
): Metadata {
  const merged: Record<string, PrimitiveMetadata | undefined> = {
    ...source.metadata,
    ...extra,
    tags: source.tags,
    sourceType: source.type,
    sourceUri,
    publicationDate: publicationDate ?? null,
    crawledAt,
    indexedAt
  };
  const filtered = Object.fromEntries(
    Object.entries(merged).filter(([, value]) => asMetadataValue(value) !== undefined)
  ) as Record<string, PrimitiveMetadata>;
  return filtered;
}

export async function writeNormalizedDocument(
  {
    documentId,
    sourceId,
    title,
    uri,
    sourceUri,
    publicationDate,
    crawledAt,
    indexedAt,
    contentHash,
    lastChangedAt,
    normalizedPath,
    markdown
  }: {
    documentId: string;
    sourceId: string;
    title: string;
    uri: string;
    sourceUri: string;
    publicationDate?: string | null;
    crawledAt?: string;
    indexedAt?: string;
    contentHash: string;
    lastChangedAt: string;
    normalizedPath: string;
    markdown: string;
  }
): Promise<void> {
  await mkdir(path.dirname(normalizedPath), { recursive: true });
  await writeFile(
    normalizedPath,
    withFrontmatter(
      {
        documentId,
        sourceId,
        title,
        uri,
        sourceUri,
        publicationDate: publicationDate ?? null,
        crawledAt,
        indexedAt,
        contentHash,
        lastChangedAt
      },
      markdown
    ),
    "utf8"
  );
}

export async function deleteDocumentArtifacts(document: DocumentRecord, workspacePath?: string): Promise<void> {
  const rawPath = document.rawPath && workspacePath
    ? await resolveStoredWorkspacePath(workspacePath, document.rawPath, "raw")
    : document.rawPath;
  const normalizedPath = workspacePath
    ? await resolveStoredWorkspacePath(workspacePath, document.normalizedPath, "normalized")
    : document.normalizedPath;
  await Promise.all([
    rawPath ? rm(rawPath, { force: true }) : Promise.resolve(),
    rm(normalizedPath, { force: true })
  ]);
}
