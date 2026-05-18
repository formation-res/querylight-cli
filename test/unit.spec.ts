import { writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { sha256 } from "../src/core/hashing.js";
import { stableId } from "../src/core/ids.js";
import { readJsonl, writeJsonl } from "../src/core/jsonl.js";
import { stripBoilerplate } from "../src/normalize/boilerplate.js";
import { normalizeWhitespace, withFrontmatter } from "../src/normalize/normalize-markdown.js";
import { extractHtmlToMarkdown } from "../src/ingest/extractors/html-extractor.js";
import { addSource, listSources, removeSource, updateSource } from "../src/sources/source-store.js";
import { ensureWorkspace } from "../src/core/workspace.js";
import { tempWorkspace, cleanupTempDirs } from "./helpers.js";

afterEach(async () => {
  await cleanupTempDirs();
});

describe("core primitives", () => {
  it("generates deterministic hashes and ids", () => {
    expect(sha256("abc")).toBe(sha256("abc"));
    expect(stableId("src", "directory", "/tmp/docs")).toBe(stableId("src", "directory", "/tmp/docs"));
    expect(stableId("src", "directory", "/tmp/docs")).not.toBe(stableId("src", "directory", "/tmp/other"));
  });

  it("round-trips jsonl records", async () => {
    const root = await tempWorkspace();
    const file = path.join(root, "records.jsonl");
    const records = [{ id: "1", title: "A" }, { id: "2", title: "B" }];
    await writeJsonl(file, records);
    await expect(readJsonl<typeof records[number]>(file)).resolves.toEqual(records);
  });
});

describe("normalization", () => {
  it("strips boilerplate and converts html to markdown", () => {
    const html = "<nav>nav</nav><main><h1>Title</h1><p>Hello world</p></main><footer>footer</footer>";
    const cleaned = stripBoilerplate(html);
    expect(cleaned).not.toContain("<nav>");
    expect(cleaned).not.toContain("<footer>");

    const extracted = extractHtmlToMarkdown(html);
    expect(extracted.title).toBe("Title");
    expect(extracted.markdown).toContain("Hello world");
  });

  it("normalizes doc-card anchors into readable markdown", () => {
    const html = `
      <main>
        <h1>Documentation</h1>
        <a class="doc-card" href="/docs/ranking/tfidf-and-bm25-ranking/">
          <span>Ranking</span>
          <h3>TF-IDF and BM25 Ranking</h3>
          <p>Choose between classic term weighting and Lucene-style BM25 scoring.</p>
        </a>
      </main>
    `;

    const extracted = extractHtmlToMarkdown(html);
    expect(extracted.markdown).toContain("### TF-IDF and BM25 Ranking");
    expect(extracted.markdown).toContain("Choose between classic term weighting");
    expect(extracted.markdown).toContain("Ranking");
    expect(extracted.markdown).toContain("/docs/ranking/tfidf-and-bm25-ranking/");
    expect(extracted.markdown).not.toContain("](/docs/ranking");
  });

  it("normalizes whitespace and writes frontmatter", () => {
    const normalized = normalizeWhitespace("a  \n\n\nb\n");
    expect(normalized).toBe("a\n\nb");

    const markdown = withFrontmatter({ id: "doc1" }, "# Title\n\nBody");
    expect(markdown).toContain("id: doc1");
    expect(markdown).toContain("# Title");
  });
});

describe("source store lifecycle", () => {
  it("adds, updates, lists, and removes sources", async () => {
    const root = await tempWorkspace();
    const { workspacePath } = await ensureWorkspace({ workspacePath: path.join(root, ".kb") });
    const source = await addSource(workspacePath, {
      type: "directory",
      uri: "/tmp/docs",
      name: "Docs",
      enabled: true,
      tags: ["docs"],
      metadata: { team: "platform" },
      createdAt: "2026-05-18T00:00:00.000Z",
      updatedAt: "2026-05-18T00:00:00.000Z"
    });

    expect((await listSources(workspacePath))[0]?.id).toBe(source.id);

    const updated = await updateSource(workspacePath, source.id, { enabled: false });
    expect(updated.enabled).toBe(false);

    await removeSource(workspacePath, source.id);
    expect(await listSources(workspacePath)).toEqual([]);
  });
});
