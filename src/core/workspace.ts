import { mkdir, stat } from "node:fs/promises";
import path from "node:path";
import { CliError, ExitCode } from "./errors.js";
import { writeDefaultConfig } from "./config.js";

const DIRS = [
  "sources",
  "documents",
  "chunks",
  "raw",
  "normalized",
  "indexes",
  "vectors",
  "models",
  "models/huggingface",
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

export async function assertWorkspaceExists(workspacePath: string): Promise<string> {
  const resolved = path.resolve(workspacePath);
  try {
    const info = await stat(resolved);
    if (!info.isDirectory()) {
      throw new CliError(`workspace is not a directory: ${resolved}`, "WORKSPACE_ERROR", ExitCode.WorkspaceError);
    }
    await stat(path.join(resolved, "config.yaml"));
    return resolved;
  } catch (error) {
    if (error instanceof CliError) {
      throw error;
    }
    throw new CliError(`workspace does not exist or is invalid: ${resolved}`, "WORKSPACE_ERROR", ExitCode.WorkspaceError);
  }
}
