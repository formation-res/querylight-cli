import path from "node:path";
import { fileExists } from "./files.js";

function relativeFromWorkspaceMarker(storedPath: string): string | null {
  const parts = path.resolve(storedPath).split(path.sep);
  const markerIndex = parts.lastIndexOf(".kb");
  if (markerIndex < 0 || markerIndex === parts.length - 1) {
    return null;
  }
  return path.join(...parts.slice(markerIndex + 1));
}

function relativeFromKnownDir(storedPath: string, workspaceSubdir?: string): string | null {
  if (!workspaceSubdir) {
    return null;
  }
  const parts = path.resolve(storedPath).split(path.sep);
  const markerIndex = parts.lastIndexOf(workspaceSubdir);
  if (markerIndex < 0 || markerIndex === parts.length - 1) {
    return null;
  }
  return path.join(...parts.slice(markerIndex));
}

export async function resolveStoredWorkspacePath(
  workspacePath: string,
  storedPath: string,
  workspaceSubdir?: string
): Promise<string> {
  const workspace = path.resolve(workspacePath);
  if (!path.isAbsolute(storedPath)) {
    return path.resolve(workspace, storedPath);
  }

  const resolvedStoredPath = path.resolve(storedPath);
  const relativePath = path.relative(workspace, resolvedStoredPath);
  if (!relativePath.startsWith("..") && !path.isAbsolute(relativePath)) {
    return resolvedStoredPath;
  }

  const relocatedRelativePath = relativeFromWorkspaceMarker(resolvedStoredPath) ?? relativeFromKnownDir(resolvedStoredPath, workspaceSubdir);
  if (relocatedRelativePath) {
    const relocatedPath = path.resolve(workspace, relocatedRelativePath);
    if (await fileExists(relocatedPath)) {
      return relocatedPath;
    }
  }

  if (await fileExists(resolvedStoredPath)) {
    return resolvedStoredPath;
  }

  return relocatedRelativePath ? path.resolve(workspace, relocatedRelativePath) : resolvedStoredPath;
}
