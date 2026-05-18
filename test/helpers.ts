import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const tempDirs: string[] = [];

export async function tempWorkspace(prefix = "qli-test-"): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

export async function cleanupTempDirs(): Promise<void> {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
}
