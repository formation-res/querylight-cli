import { mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { unzipSync, zipSync } from "fflate";
import { CliError, ExitCode } from "./errors.js";
import { sha256 } from "./hashing.js";
import { assertWorkspaceExists } from "./workspace.js";

type WorkspaceArchiveResolution = {
  workspacePath: string;
  archivePath?: string;
};

export function isWorkspaceArchivePath(workspacePath: string): boolean {
  return workspacePath.toLowerCase().endsWith(".zip");
}

async function collectFiles(root: string, outputPath: string): Promise<Record<string, Uint8Array>> {
  const files: Record<string, Uint8Array> = {};
  const resolvedOutput = path.resolve(outputPath);

  async function visit(dir: string): Promise<void> {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const absolute = path.join(dir, entry.name);
      if (path.resolve(absolute) === resolvedOutput) {
        continue;
      }
      if (entry.isDirectory()) {
        await visit(absolute);
        continue;
      }
      if (!entry.isFile()) {
        continue;
      }
      const relative = path.relative(root, absolute).split(path.sep).join("/");
      files[relative] = new Uint8Array(await readFile(absolute));
    }
  }

  await visit(root);
  return files;
}

export async function packageWorkspaceArchive(
  {
    workspacePath,
    outputPath,
    force = false
  }: {
    workspacePath: string;
    outputPath: string;
    force?: boolean;
  }
): Promise<{ workspacePath: string; archivePath: string; fileCount: number; sizeBytes: number }> {
  const workspace = await assertWorkspaceExists(workspacePath);
  const archivePath = path.resolve(outputPath);
  try {
    await stat(archivePath);
    if (!force) {
      throw new CliError(`archive already exists: ${archivePath}`, "INVALID_ARGUMENT", ExitCode.InvalidArguments);
    }
  } catch (error) {
    if (error instanceof CliError) {
      throw error;
    }
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
  }

  const files = await collectFiles(workspace, archivePath);
  const archive = zipSync(files, { level: 6 });
  await mkdir(path.dirname(archivePath), { recursive: true });
  await writeFile(archivePath, archive);
  const archiveStat = await stat(archivePath);
  return {
    workspacePath: workspace,
    archivePath,
    fileCount: Object.keys(files).length,
    sizeBytes: archiveStat.size
  };
}

function assertSafeArchiveEntry(name: string): void {
  const normalized = path.posix.normalize(name);
  if (
    name.startsWith("/") ||
    normalized === "." ||
    normalized.startsWith("../") ||
    normalized.includes("/../")
  ) {
    throw new CliError(`unsafe archive entry: ${name}`, "WORKSPACE_ERROR", ExitCode.WorkspaceError);
  }
}

async function archiveCachePath(archivePath: string): Promise<string> {
  const info = await stat(archivePath);
  const key = sha256(`${path.resolve(archivePath)}:${info.size}:${info.mtimeMs}`).slice(0, 24);
  return path.join(os.tmpdir(), "qli-workspace-archives", key);
}

export async function resolveReadableWorkspace(workspacePath: string): Promise<WorkspaceArchiveResolution> {
  const resolved = path.resolve(workspacePath);
  if (!isWorkspaceArchivePath(resolved)) {
    return { workspacePath: await assertWorkspaceExists(resolved) };
  }

  const archive = await readFile(resolved);
  const extractRoot = await archiveCachePath(resolved);
  const workspaceRoot = path.join(extractRoot, "workspace");
  try {
    await assertWorkspaceExists(workspaceRoot);
    return { workspacePath: workspaceRoot, archivePath: resolved };
  } catch {
    // Rebuild the cache entry below.
  }

  await rm(extractRoot, { recursive: true, force: true });
  await mkdir(workspaceRoot, { recursive: true });
  const entries = unzipSync(new Uint8Array(archive));
  await Promise.all(Object.entries(entries).map(async ([entryName, data]) => {
    assertSafeArchiveEntry(entryName);
    const target = path.join(workspaceRoot, ...entryName.split("/"));
    if (entryName.endsWith("/")) {
      await mkdir(target, { recursive: true });
      return;
    }
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, Buffer.from(data));
  }));
  return { workspacePath: await assertWorkspaceExists(workspaceRoot), archivePath: resolved };
}

export async function assertWritableWorkspacePath(workspacePath: string): Promise<string> {
  const resolved = path.resolve(workspacePath);
  if (isWorkspaceArchivePath(resolved)) {
    throw new CliError("zip workspaces are read-only; package a rebuilt directory workspace instead", "WORKSPACE_ERROR", ExitCode.WorkspaceError);
  }
  return resolved;
}
