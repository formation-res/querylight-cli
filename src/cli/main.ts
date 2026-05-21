#!/usr/bin/env node
import { runCli } from "./run-cli.js";

try {
  const result = await runCli(process.argv.slice(2), {
    onStdout(value) {
      process.stdout.write(`${value}\n`);
    },
    onStderr(value) {
      process.stderr.write(`${value}\n`);
    }
  });
  process.exitCode = result.exitCode;
} catch (error) {
  const message = error instanceof Error ? error.stack ?? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
}
