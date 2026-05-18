import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { saveChunks } from "../src/chunk/chunk-store.js";
import { ensureWorkspace } from "../src/core/workspace.js";
import { stableId } from "../src/core/ids.js";
import { writeJsonl } from "../src/core/jsonl.js";
import { ingestSources, reprocessDocuments } from "../src/ingest/ingest-service.js";
import { parseRssFeedDocument } from "../src/ingest/adapters/rss-adapter.js";
import { addSource } from "../src/sources/source-store.js";
import type { DocumentRecord, Source } from "../src/types/models.js";
import { cleanupTempDirs, tempWorkspace } from "./helpers.js";

afterEach(async () => {
  vi.restoreAllMocks();
  await cleanupTempDirs();
});

function htmlPage(title: string, body: string, publicationDate?: string): string {
  const dateMeta = publicationDate ? `<meta property="article:published_time" content="${publicationDate}">` : "";
  return `<!doctype html><html><head><title>${title}</title>${dateMeta}</head><body><main><h1>${title}</h1><p>${body}</p></main></body></html>`;
}

describe("conditional remote ingest", () => {
  it("preserves crawledAt and raw content on 304 while updating lastSeenAt", async () => {
    const root = await tempWorkspace("qli-304-");
    const { workspacePath } = await ensureWorkspace({ workspacePath: path.join(root, ".kb") });
    const source = await addSource(workspacePath, {
      type: "url",
      uri: "https://example.com/article",
      name: "Article",
      enabled: true,
      tags: ["docs"],
      metadata: {},
      createdAt: "2026-05-18T00:00:00.000Z",
      updatedAt: "2026-05-18T00:00:00.000Z"
    });

    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(htmlPage("Auth", "First body"), {
        status: 200,
        headers: { "content-type": "text/html", etag: "\"v1\"", "last-modified": "Sun, 18 May 2025 00:00:00 GMT" }
      }))
      .mockResolvedValueOnce(new Response(null, {
        status: 304,
        headers: { etag: "\"v1\"", "last-modified": "Sun, 18 May 2025 00:00:00 GMT" }
      }));
    vi.stubGlobal("fetch", fetchMock);

    await ingestSources({ workspacePath, sourceIds: [source.id] });
    const firstDocuments = await import("../src/core/jsonl.js").then((mod) => mod.readJsonl<DocumentRecord>(path.join(workspacePath, "documents", "documents.jsonl")));
    const first = firstDocuments[0]!;
    const firstRaw = await readFile(first.rawPath!, "utf8");

    await new Promise((resolve) => setTimeout(resolve, 10));
    await ingestSources({ workspacePath, sourceIds: [source.id] });
    const secondDocuments = await import("../src/core/jsonl.js").then((mod) => mod.readJsonl<DocumentRecord>(path.join(workspacePath, "documents", "documents.jsonl")));
    const second = secondDocuments[0]!;
    const secondRaw = await readFile(second.rawPath!, "utf8");

    expect(fetchMock.mock.calls[1]?.[1]).toMatchObject({
      headers: expect.objectContaining({
        "if-none-match": "\"v1\"",
        "if-modified-since": "Sun, 18 May 2025 00:00:00 GMT"
      })
    });
    expect(second.crawledAt).toBe(first.crawledAt);
    expect(second.lastChangedAt).toBe(first.lastChangedAt);
    expect(second.lastSeenAt > first.lastSeenAt).toBe(true);
    expect(secondRaw).toBe(firstRaw);
  });

  it("reprocesses normalized content from stored raw without fetching", async () => {
    const root = await tempWorkspace("qli-reprocess-");
    const { workspacePath } = await ensureWorkspace({ workspacePath: path.join(root, ".kb") });
    const source = await addSource(workspacePath, {
      type: "url",
      uri: "https://example.com/reprocess",
      name: "Reprocess",
      enabled: true,
      tags: ["docs"],
      metadata: {},
      createdAt: "2026-05-18T00:00:00.000Z",
      updatedAt: "2026-05-18T00:00:00.000Z"
    });

    const fetchMock = vi.fn().mockResolvedValue(new Response(htmlPage("Doc", "Original body"), {
      status: 200,
      headers: { "content-type": "text/html", etag: "\"v1\"" }
    }));
    vi.stubGlobal("fetch", fetchMock);

    await ingestSources({ workspacePath, sourceIds: [source.id] });
    const documents = await import("../src/core/jsonl.js").then((mod) => mod.readJsonl<DocumentRecord>(path.join(workspacePath, "documents", "documents.jsonl")));
    const document = documents[0]!;
    await writeFile(document.rawPath!, htmlPage("Doc", "Reprocessed body"), "utf8");

    await new Promise((resolve) => setTimeout(resolve, 10));
    await reprocessDocuments({ workspacePath, sourceId: source.id });
    const updatedDocuments = await import("../src/core/jsonl.js").then((mod) => mod.readJsonl<DocumentRecord>(path.join(workspacePath, "documents", "documents.jsonl")));
    const updated = updatedDocuments[0]!;
    const normalized = await readFile(updated.normalizedPath, "utf8");

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(updated.crawledAt).toBe(document.crawledAt);
    expect(updated.indexedAt && document.indexedAt && updated.indexedAt > document.indexedAt).toBe(true);
    expect(normalized).toContain("Reprocessed body");
  });
});

describe("rss parsing and retention", () => {
  it("parses representative RSS and Atom feeds", async () => {
    const rss = `<?xml version="1.0"?><rss version="2.0"><channel><title>Demo</title><item><title>One</title><link>https://example.com/one</link><pubDate>Mon, 01 Jan 2024 00:00:00 GMT</pubDate></item></channel></rss>`;
    const atom = `<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom"><title>Demo</title><entry><title>Two</title><link href="https://example.com/two" /><updated>2024-01-02T00:00:00Z</updated></entry></feed>`;
    const source: Source = {
      id: "src_rss",
      type: "rss",
      uri: "https://example.com/feed.xml",
      name: "Feed",
      enabled: true,
      tags: [],
      metadata: {},
      createdAt: "2026-05-18T00:00:00.000Z",
      updatedAt: "2026-05-18T00:00:00.000Z"
    };

    const parsedRss = await parseRssFeedDocument(rss, source);
    const parsedAtom = await parseRssFeedDocument(atom, source);

    expect(parsedRss[0]?.url).toBe("https://example.com/one");
    expect(parsedAtom[0]?.url).toBe("https://example.com/two");
  });

  it("falls back to feedparser when feedsmith throws", async () => {
    vi.resetModules();
    vi.doMock("feedsmith", () => ({
      parseFeed: () => {
        throw new Error("boom");
      }
    }));
    const { parseRssFeedDocument: parseWithFallback } = await import("../src/ingest/adapters/rss-adapter.js");
    const xml = `<?xml version="1.0"?><rss version="2.0"><channel><title>Demo</title><item><title>One</title><link>https://example.com/fallback</link></item></channel></rss>`;
    const items = await parseWithFallback(xml, {
      id: "src_rss",
      type: "rss",
      uri: "https://example.com/feed.xml",
      name: "Feed",
      enabled: true,
      tags: [],
      metadata: {},
      createdAt: "2026-05-18T00:00:00.000Z",
      updatedAt: "2026-05-18T00:00:00.000Z"
    });

    expect(items[0]?.url).toBe("https://example.com/fallback");
    vi.doUnmock("feedsmith");
    vi.resetModules();
  });

  it("retains null-dated items and hard-deletes expired rss documents and chunks", async () => {
    const root = await tempWorkspace("qli-rss-retention-");
    const { workspacePath } = await ensureWorkspace({ workspacePath: path.join(root, ".kb") });
    const source = await addSource(workspacePath, {
      type: "rss",
      uri: "https://example.com/feed.xml",
      name: "Feed",
      enabled: true,
      tags: ["news"],
      metadata: {},
      crawl: { retentionDays: 365, fetchArticles: true },
      createdAt: "2026-05-18T00:00:00.000Z",
      updatedAt: "2026-05-18T00:00:00.000Z"
    });

    const expiredUrl = "https://example.com/old";
    const expiredId = stableId("doc", source.id, expiredUrl);
    const rawPath = path.join(workspacePath, "raw", source.id, "old.html");
    const normalizedPath = path.join(workspacePath, "normalized", `${expiredId}.md`);
    await mkdir(path.dirname(rawPath), { recursive: true });
    await writeFile(rawPath, htmlPage("Old", "Old body", "2020-01-01T00:00:00Z"), "utf8");
    await writeFile(normalizedPath, "# Old\n\nOld body\n", "utf8");
    await writeJsonl(path.join(workspacePath, "documents", "documents.jsonl"), [
      {
        id: expiredId,
        sourceId: source.id,
        sourceType: "rss",
        title: "Old",
        uri: expiredUrl,
        sourceUri: source.uri,
        mimeType: "text/html",
        rawPath,
        normalizedPath,
        contentHash: "old-hash",
        metadata: { tags: ["news"], sourceUri: source.uri, publicationDate: "2020-01-01T00:00:00.000Z" },
        publicationDate: "2020-01-01T00:00:00.000Z",
        crawledAt: "2026-05-18T00:00:00.000Z",
        firstSeenAt: "2026-05-18T00:00:00.000Z",
        lastSeenAt: "2026-05-18T00:00:00.000Z",
        lastChangedAt: "2026-05-18T00:00:00.000Z",
        indexedAt: "2026-05-18T00:00:00.000Z"
      }
    ]);
    await saveChunks(workspacePath, [
      {
        id: "chunk-old",
        documentId: expiredId,
        sourceId: source.id,
        title: "Old",
        uri: expiredUrl,
        headingPath: ["Old"],
        text: "Old body",
        contentHash: "chunk-old",
        metadata: { tags: ["news"] },
        firstSeenAt: "2026-05-18T00:00:00.000Z",
        lastSeenAt: "2026-05-18T00:00:00.000Z",
        lastChangedAt: "2026-05-18T00:00:00.000Z"
      }
    ]);

    const feedXml = `<?xml version="1.0"?><rss version="2.0"><channel><title>Feed</title><item><title>Fresh</title><link>https://example.com/fresh</link></item></channel></rss>`;
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === source.uri) {
        return new Response(feedXml, { status: 200, headers: { "content-type": "application/rss+xml" } });
      }
      if (url === "https://example.com/fresh") {
        return new Response(htmlPage("Fresh", "Fresh body"), {
          status: 200,
          headers: { "content-type": "text/html", etag: "\"fresh\"" }
        });
      }
      throw new Error(`unexpected url ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    await ingestSources({ workspacePath, sourceIds: [source.id] });

    const documents = await import("../src/core/jsonl.js").then((mod) => mod.readJsonl<DocumentRecord>(path.join(workspacePath, "documents", "documents.jsonl")));
    const chunks = await import("../src/chunk/chunk-store.js").then((mod) => mod.loadChunks(workspacePath));

    expect(documents.map((document) => document.uri)).toEqual(["https://example.com/fresh"]);
    expect(documents[0]?.publicationDate).toBeNull();
    expect(chunks).toHaveLength(0);
    await expect(stat(rawPath)).rejects.toThrow();
    await expect(stat(normalizedPath)).rejects.toThrow();
  });

  it("falls back to workspace retention for existing rss sources without a stored override", async () => {
    const root = await tempWorkspace("qli-rss-retention-config-");
    const { workspacePath } = await ensureWorkspace({ workspacePath: path.join(root, ".kb") });
    await writeFile(path.join(workspacePath, "config.yaml"), "crawler:\n  retentionDays: 30\n", "utf8");
    const source = await addSource(workspacePath, {
      type: "rss",
      uri: "https://example.com/feed.xml",
      name: "Feed",
      enabled: true,
      tags: ["news"],
      metadata: {},
      crawl: { fetchArticles: true },
      createdAt: "2026-05-18T00:00:00.000Z",
      updatedAt: "2026-05-18T00:00:00.000Z"
    });

    const expiredUrl = "https://example.com/old";
    const expiredId = stableId("doc", source.id, expiredUrl);
    const rawPath = path.join(workspacePath, "raw", source.id, "old.html");
    const normalizedPath = path.join(workspacePath, "normalized", `${expiredId}.md`);
    await mkdir(path.dirname(rawPath), { recursive: true });
    await writeFile(rawPath, htmlPage("Old", "Old body", "2026-03-01T00:00:00Z"), "utf8");
    await writeFile(normalizedPath, "# Old\n\nOld body\n", "utf8");
    await writeJsonl(path.join(workspacePath, "documents", "documents.jsonl"), [
      {
        id: expiredId,
        sourceId: source.id,
        sourceType: "rss",
        title: "Old",
        uri: expiredUrl,
        sourceUri: source.uri,
        mimeType: "text/html",
        rawPath,
        normalizedPath,
        contentHash: "old-hash",
        metadata: { tags: ["news"], sourceUri: source.uri, publicationDate: "2026-03-01T00:00:00.000Z" },
        publicationDate: "2026-03-01T00:00:00.000Z",
        crawledAt: "2026-05-18T00:00:00.000Z",
        firstSeenAt: "2026-05-18T00:00:00.000Z",
        lastSeenAt: "2026-05-18T00:00:00.000Z",
        lastChangedAt: "2026-05-18T00:00:00.000Z",
        indexedAt: "2026-05-18T00:00:00.000Z"
      }
    ]);

    const feedXml = `<?xml version="1.0"?><rss version="2.0"><channel><title>Feed</title><item><title>Fresh</title><link>https://example.com/fresh</link></item></channel></rss>`;
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === source.uri) {
        return new Response(feedXml, { status: 200, headers: { "content-type": "application/rss+xml" } });
      }
      if (url === "https://example.com/fresh") {
        return new Response(htmlPage("Fresh", "Fresh body"), {
          status: 200,
          headers: { "content-type": "text/html", etag: "\"fresh\"" }
        });
      }
      throw new Error(`unexpected url ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    await ingestSources({ workspacePath, sourceIds: [source.id] });

    const documents = await import("../src/core/jsonl.js").then((mod) => mod.readJsonl<DocumentRecord>(path.join(workspacePath, "documents", "documents.jsonl")));
    expect(documents.map((document) => document.uri)).toEqual(["https://example.com/fresh"]);
    await expect(stat(rawPath)).rejects.toThrow();
    await expect(stat(normalizedPath)).rejects.toThrow();
  });
});
