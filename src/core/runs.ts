import path from "node:path";
import type { RunRecord } from "../types/models.js";
import { readJsonl, writeJsonl } from "./jsonl.js";

export async function writeRun(workspacePath: string, run: RunRecord): Promise<void> {
  await writeJsonl(path.join(workspacePath, "runs", `${run.id}.json`), [run]);
}

export async function listRuns(workspacePath: string): Promise<RunRecord[]> {
  const fs = await import("node:fs/promises");
  const dir = path.join(workspacePath, "runs");
  try {
    const entries = await fs.readdir(dir);
    const records = await Promise.all(entries.filter((name) => name.endsWith(".json")).map(async (name) => {
      const runs = await readJsonl<RunRecord>(path.join(dir, name));
      return runs[0];
    }));
    return records.filter((record): record is RunRecord => record != null).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  } catch {
    return [];
  }
}
