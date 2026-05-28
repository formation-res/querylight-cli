import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import packageJson from "../package.json" with { type: "json" };

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: ["ignore", "pipe", "pipe"],
      ...options
    });
    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve({ stdout, stderr });
        return;
      }
      reject(new Error(`${command} ${args.join(" ")} failed with exit code ${code}\n${stderr}`));
    });
  });
}

const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "qli-release-version-"));
const workspacePath = path.join(workspaceRoot, ".kb");

try {
  const { stdout } = await run("node", ["dist/cli/main.js", "init", "--workspace", workspacePath, "--json"], {
    cwd: new URL("..", import.meta.url)
  });
  const parsed = JSON.parse(stdout);

  assert.equal(parsed.ok, true, "Expected qli init --json to succeed");
  assert.equal(parsed.version, packageJson.version, `Built CLI reported version ${parsed.version}, expected ${packageJson.version}`);
  process.stdout.write(`Verified built CLI version ${parsed.version}\n`);
} finally {
  await rm(workspaceRoot, { recursive: true, force: true });
}
