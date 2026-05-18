import { mkdir } from "node:fs/promises";
import path from "node:path";
import { writeDefaultConfig } from "./config.js";

const DIRS = [
  "sources",
  "documents",
  "chunks",
  "raw",
  "normalized",
  "indexes",
  "runs",
  "logs"
] as const;

export async function ensureWorkspace(
  {
    workspacePath,
    force = false
  }: {
    workspacePath: string;
    force?: boolean;
  }
): Promise<{ workspacePath: string }> {
  const resolved = path.resolve(workspacePath);
  await mkdir(resolved, { recursive: true });
  for (const dir of DIRS) {
    await mkdir(path.join(resolved, dir), { recursive: true });
  }
  await writeDefaultConfig(resolved, force);
  return { workspacePath: resolved };
}
