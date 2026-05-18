import path from "node:path";
import { loadConfig } from "../core/config.js";
import { CliError, ExitCode } from "../core/errors.js";
import { fileExists } from "../core/files.js";
import { readJsonl } from "../core/jsonl.js";
import type { DenseVectorRecord, DocumentRecord, RelatedDocumentResult, RelatedDocumentsResponseData } from "../types/models.js";
import { denseVectorPath, readDensePayload } from "../vector/store.js";

type DocumentVector = {
  document: DocumentRecord;
  embedding: number[];
};

function cosineSimilarity(left: number[], right: number[]): number {
  let dot = 0;
  let leftNorm = 0;
  let rightNorm = 0;
  for (let index = 0; index < left.length; index += 1) {
    const leftValue = left[index] ?? 0;
    const rightValue = right[index] ?? 0;
    dot += leftValue * rightValue;
    leftNorm += leftValue * leftValue;
    rightNorm += rightValue * rightValue;
  }
  if (leftNorm === 0 || rightNorm === 0) {
    return 0;
  }
  return dot / (Math.sqrt(leftNorm) * Math.sqrt(rightNorm));
}

function normalizeVector(values: number[]): number[] {
  const norm = Math.sqrt(values.reduce((sum, value) => sum + (value * value), 0));
  if (norm === 0) {
    return values.map(() => 0);
  }
  return values.map((value) => value / norm);
}

function averageEmbeddings(records: DenseVectorRecord[], dimensions: number): number[] {
  const totals = new Array<number>(dimensions).fill(0);
  for (const record of records) {
    for (let index = 0; index < dimensions; index += 1) {
      totals[index] = (totals[index] ?? 0) + (record.embedding[index] ?? 0);
    }
  }
  return normalizeVector(totals.map((value) => value / Math.max(records.length, 1)));
}

function resolveDocumentSelector(documents: DocumentRecord[], selector: string): DocumentRecord {
  const normalized = selector.trim().toLowerCase();
  const matches = documents.filter((document) =>
    document.id.toLowerCase() === normalized ||
    document.uri.toLowerCase() === normalized ||
    (document.canonicalUri?.toLowerCase() === normalized)
  );
  if (matches.length === 0) {
    throw new CliError(`document not found: ${selector}`, "DOCUMENT_NOT_FOUND", ExitCode.InvalidArguments);
  }
  if (matches.length > 1) {
    throw new CliError(`document selector is ambiguous: ${selector}`, "DOCUMENT_SELECTOR_AMBIGUOUS", ExitCode.InvalidArguments);
  }
  return matches[0]!;
}

function buildDocumentVectors(documents: DocumentRecord[], denseChunks: DenseVectorRecord[], dimensions: number): Map<string, DocumentVector> {
  const byDocument = new Map<string, DenseVectorRecord[]>();
  for (const chunk of denseChunks) {
    const existing = byDocument.get(chunk.documentId);
    if (existing) {
      existing.push(chunk);
    } else {
      byDocument.set(chunk.documentId, [chunk]);
    }
  }

  return new Map(documents.flatMap((document) => {
    const records = byDocument.get(document.id);
    if (!records?.length) {
      return [];
    }
    return [[document.id, { document, embedding: averageEmbeddings(records, dimensions) } satisfies DocumentVector] as const];
  }));
}

export async function findRelatedDocuments(
  {
    workspacePath,
    document,
    topK
  }: {
    workspacePath: string;
    document: string;
    topK: number;
  }
): Promise<RelatedDocumentsResponseData> {
  const config = await loadConfig(workspacePath);
  if (!config.retrieval.dense.enabled) {
    throw new CliError("dense retrieval is disabled in config; enable retrieval.dense.enabled and rebuild", "DENSE_RETRIEVAL_DISABLED", ExitCode.QueryError);
  }
  if (!await fileExists(denseVectorPath(workspacePath))) {
    throw new CliError("dense vector index is not built; run `qli models pull --dense` and `qli rebuild`", "DENSE_INDEX_MISSING", ExitCode.QueryError);
  }

  const documents = await readJsonl<DocumentRecord>(path.join(workspacePath, "documents", "documents.jsonl"));
  const selected = resolveDocumentSelector(documents, document);
  const densePayload = await readDensePayload(workspacePath);
  const vectors = buildDocumentVectors(documents, densePayload.chunks, densePayload.metadata.dimensions);
  const sourceVector = vectors.get(selected.id);
  if (!sourceVector) {
    throw new CliError(`dense vectors are missing for document: ${document}`, "DOCUMENT_VECTOR_MISSING", ExitCode.QueryError);
  }

  const results: RelatedDocumentResult[] = [...vectors.values()]
    .filter((candidate) => candidate.document.id !== selected.id)
    .map((candidate) => ({
      documentId: candidate.document.id,
      sourceId: candidate.document.sourceId,
      score: cosineSimilarity(sourceVector.embedding, candidate.embedding),
      title: candidate.document.title,
      uri: candidate.document.uri,
      metadata: candidate.document.metadata
    }))
    .sort((left, right) => right.score - left.score)
    .slice(0, topK);

  return {
    sourceDocument: {
      documentId: selected.id,
      sourceId: selected.sourceId,
      title: selected.title,
      uri: selected.uri
    },
    retrievalMode: "dense",
    results
  };
}
