import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runSparsePython, setSparseExecFileSyncForTests } from "../src/vector/runtime.js";

afterEach(() => {
  setSparseExecFileSyncForTests(null);
  delete process.env.QLI_HOME;
});

describe("runSparsePython", () => {
  it("passes sparse payload through a temp file and removes it after execution", async () => {
    process.env.QLI_HOME = "/tmp/qli-home";
    let capturedPayloadPath = "";
    setSparseExecFileSyncForTests((_command, args) => {
      capturedPayloadPath = String(args[args.length - 1]);
      expect(capturedPayloadPath.endsWith(`${path.sep}payload.json`)).toBe(true);
      expect(existsSync(capturedPayloadPath)).toBe(true);
      const payload = JSON.parse(readFileSync(capturedPayloadPath, "utf8")) as { output_path?: string };
      expect(payload.output_path).toBeTruthy();
      writeFileSync(payload.output_path!, "{\"ok\":true,\"from\":\"file\"}", "utf8");
      return "{\"ok\":true}";
    });

    const output = await runSparsePython({
      workspacePath: "/tmp/workspace",
      config: {
        enabled: true,
        modelId: "demo-model",
        cacheDir: "~/.qli/models/huggingface",
        documentTopTokens: 64,
        documentBatchSize: 16,
        queryEncoding: "tokenizer-token-weights",
        documentEncoding: "masked-lm-max-log1p-relu",
        chunkTextMode: "title-heading-text"
      },
      payload: {
        action: "download_only",
        model_id: "demo-model"
      },
      importMetaUrl: new URL("../src/vector/sparse.ts", import.meta.url).href
    });

    expect(output).toBe("{\"ok\":true,\"from\":\"file\"}");
    expect(capturedPayloadPath).not.toBe("");
    expect(existsSync(capturedPayloadPath)).toBe(false);
  });
});
