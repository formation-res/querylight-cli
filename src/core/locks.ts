import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { CliError, ExitCode } from "./errors.js";

type LockOwner = {
  pid: number;
  command: string;
  createdAt: string;
};

function lockPath(workspacePath: string, name: string): string {
  return path.join(workspacePath, "locks", `${name}.lock`);
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function readOwner(directory: string): Promise<LockOwner | null> {
  try {
    return JSON.parse(await readFile(path.join(directory, "owner.json"), "utf8")) as LockOwner;
  } catch {
    return null;
  }
}

async function acquireWorkspaceLock(workspacePath: string, name: string, command: string): Promise<string> {
  const directory = lockPath(workspacePath, name);
  await mkdir(path.dirname(directory), { recursive: true });
  try {
    await mkdir(directory);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "EEXIST") {
      throw error;
    }
    const owner = await readOwner(directory);
    if (owner && Number.isInteger(owner.pid) && !isProcessAlive(owner.pid)) {
      await rm(directory, { recursive: true, force: true });
      await mkdir(directory);
    } else {
      const detail = owner ? `pid ${owner.pid} (${owner.command}, started ${owner.createdAt})` : "unknown owner";
      throw new CliError(`workspace is locked by another writer: ${detail}`, "WORKSPACE_LOCKED", ExitCode.WorkspaceError);
    }
  }
  await writeFile(path.join(directory, "owner.json"), JSON.stringify({
    pid: process.pid,
    command,
    createdAt: new Date().toISOString()
  }, null, 2), "utf8");
  return directory;
}

export async function withWorkspaceLock<T>(
  workspacePath: string,
  name: string,
  command: string,
  fn: () => Promise<T>
): Promise<T> {
  const directory = await acquireWorkspaceLock(workspacePath, name, command);
  try {
    return await fn();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
