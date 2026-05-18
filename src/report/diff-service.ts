import path from "node:path";
import { readJsonl } from "../core/jsonl.js";
import { listRuns } from "../core/runs.js";
import type { DocumentRecord, RunRecord } from "../types/models.js";

function chooseBaselineRun(runs: RunRecord[], since?: string): RunRecord | undefined {
  if (since === "last-run") {
    return runs.at(-1);
  }
  if (since) {
    return runs.filter((run) => run.createdAt < since).at(-1) ?? runs.at(-1);
  }
  return runs.at(-1);
}

export async function diffWorkspace(
  {
    workspacePath,
    sourceId,
    documentId,
    since
  }: {
    workspacePath: string;
    sourceId?: string;
    documentId?: string;
    since?: string;
  }
): Promise<{
  changedDocuments: Array<{ id: string; title: string; uri: string; sourceId: string; previousHash?: string; currentHash: string }>;
}> {
  const current = await readJsonl<DocumentRecord>(path.join(workspacePath, "documents", "documents.jsonl"));
  const baseline = chooseBaselineRun(await listRuns(workspacePath), since);
  const previous = new Map((baseline?.documentsSnapshot ?? []).map((document) => [document.id, document]));
  const changedDocuments = current
    .filter((document) => (!sourceId || document.sourceId === sourceId) && (!documentId || document.id === documentId))
    .filter((document) => {
      const prior = previous.get(document.id);
      return !prior || prior.contentHash !== document.contentHash || (since && document.lastChangedAt >= since);
    })
    .map((document) => ({
      id: document.id,
      title: document.title,
      uri: document.uri,
      sourceId: document.sourceId,
      previousHash: previous.get(document.id)?.contentHash,
      currentHash: document.contentHash
    }));
  return { changedDocuments };
}

export function renderChangeReport(diff: { changedDocuments: Array<{ id: string; title: string; uri: string; sourceId: string }> }): string {
  return [
    "# Knowledge Base Change Report",
    "",
    "## Summary",
    "",
    `Changed documents: ${diff.changedDocuments.length}`,
    "",
    "## Added Documents",
    "",
    "_No added documents in this simple report._",
    "",
    "## Changed Documents",
    "",
    ...diff.changedDocuments.map((document) => `- ${document.title} (${document.uri}) [${document.id}]`),
    "",
    "## Removed or Missing Documents",
    "",
    "_Removal tracking is not available for this report._",
    "",
    "## Notable Changed Sections",
    "",
    ...diff.changedDocuments.map((document) => `- ${document.sourceId}: ${document.title}`)
  ].join("\n");
}
