import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFile, execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import type { DenseVectorModelConfig, SparseVectorModelConfig } from "../types/models.js";
import { fileExists } from "../core/files.js";

type SparseExecOptions = {
  encoding: BufferEncoding;
  maxBuffer: number;
  env: NodeJS.ProcessEnv;
};

type SparseExecFileSync = (file: string, args: string[], options: SparseExecOptions) => string;

let sparseExecFileSync: SparseExecFileSync = execFileSync as SparseExecFileSync;

export function setSparseExecFileSyncForTests(fn: SparseExecFileSync | null): void {
  sparseExecFileSync = fn ?? (execFileSync as SparseExecFileSync);
}

export function resolveQliHomeDir(): string {
  return path.resolve(process.env.QLI_HOME ?? path.join(os.homedir(), ".qli"));
}

export function resolveCacheDir(workspacePath: string, configuredPath: string): string {
  if (configuredPath === "~/.qli") {
    return resolveQliHomeDir();
  }
  if (configuredPath.startsWith("~/.qli/")) {
    return path.join(resolveQliHomeDir(), configuredPath.slice("~/.qli/".length));
  }
  if (configuredPath === "~") {
    return os.homedir();
  }
  if (configuredPath.startsWith("~/")) {
    return path.join(os.homedir(), configuredPath.slice(2));
  }
  return path.isAbsolute(configuredPath) ? configuredPath : path.resolve(workspacePath, configuredPath.replace(/^\.kb\//, ""));
}

export function packageRootFromImportMeta(importMetaUrl: string): string {
  return path.resolve(path.dirname(fileURLToPath(importMetaUrl)), "..");
}

export async function sparseScriptPath(importMetaUrl: string): Promise<string> {
  const base = packageRootFromImportMeta(importMetaUrl);
  const candidates = [
    path.join(base, "scripts", "sparse-encode.py"),
    path.join(base, "..", "scripts", "sparse-encode.py")
  ];
  for (const candidate of candidates) {
    if (await fileExists(candidate)) {
      return path.resolve(candidate);
    }
  }
  throw new Error(`sparse helper script not found; checked ${candidates.join(", ")}`);
}

export async function ensureUvAvailable(): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    execFile("uv", ["--version"], (error) => error ? reject(error) : resolve());
  });
}

export async function isUvAvailable(): Promise<boolean> {
  try {
    await ensureUvAvailable();
    return true;
  } catch {
    return false;
  }
}

export async function runSparsePython(
  {
    workspacePath,
    config,
    payload,
    importMetaUrl
  }: {
    workspacePath: string;
    config: SparseVectorModelConfig;
    payload: object;
    importMetaUrl: string;
  }
): Promise<string> {
  const cacheDir = resolveCacheDir(workspacePath, config.cacheDir);
  const scriptPath = await sparseScriptPath(importMetaUrl);
  const payloadDir = await mkdtemp(path.join(os.tmpdir(), "qli-sparse-"));
  const payloadPath = path.join(payloadDir, "payload.json");
  await writeFile(payloadPath, JSON.stringify(payload), "utf8");
  try {
    return sparseExecFileSync(
      "uv",
      [
        "run",
        "--with",
        "torch",
        "--with",
        "transformers",
        "--with",
        "huggingface_hub",
        "python",
        scriptPath,
        payloadPath
      ],
      {
        encoding: "utf8",
        maxBuffer: 1024 * 1024 * 1024,
        env: {
          ...process.env,
          HF_HOME: cacheDir
        }
      }
    );
  } finally {
    await rm(payloadDir, { recursive: true, force: true });
  }
}

export async function getDenseTransformersRuntime(cacheDir: string): Promise<{
  env: { cacheDir: string; allowLocalModels: boolean };
  pipeline: typeof import("@huggingface/transformers").pipeline;
}> {
  const transformers = await import("@huggingface/transformers");
  transformers.env.cacheDir = cacheDir;
  transformers.env.allowLocalModels = true;
  return {
    env: transformers.env,
    pipeline: transformers.pipeline
  };
}
