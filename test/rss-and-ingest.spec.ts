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

function rssFeed(itemUrls: string[]): string {
  const items = itemUrls
    .map((url, index) => `<item><title>Item ${index + 1}</title><link>${url}</link><pubDate>Mon, 01 Jan 2024 00:00:00 GMT</pubDate></item>`)
    .join("");
  return `<?xml version="1.0"?><rss version="2.0"><channel><title>Feed</title>${items}</channel></rss>`;
}

describe("conditional remote ingest", () => {
  it("normalizes website fragment links before indexing documents", async () => {
    const root = await tempWorkspace("qli-website-fragments-");
    const { workspacePath } = await ensureWorkspace({ workspacePath: path.join(root, ".kb") });
    const source = await addSource(workspacePath, {
      type: "website",
      uri: "https://example.com/",
      name: "Example",
      enabled: true,
      tags: ["site"],
      metadata: {},
      crawl: { maxDepth: 1, maxPages: 10, useSitemap: false, rateLimitMs: 0 },
      createdAt: "2026-05-18T00:00:00.000Z",
      updatedAt: "2026-05-18T00:00:00.000Z"
    });

    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "https://example.com/robots.txt") {
        return new Response("", { status: 404 });
      }
      if (url === "https://example.com/") {
        return new Response(`<!doctype html><html><head><title>Home</title></head><body><main>
          <h1>Home</h1>
          <a href="#about">About</a>
          <a href="#ideas">Ideas</a>
          <a href="/pricing">Pricing</a>
        </main></body></html>`, { status: 200, headers: { "content-type": "text/html" } });
      }
      if (url === "https://example.com/pricing") {
        return new Response(htmlPage("Pricing", "Plan details"), {
          status: 200,
          headers: { "content-type": "text/html" }
        });
      }
      throw new Error(`unexpected url ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    await ingestSources({ workspacePath, sourceIds: [source.id] });
    const documents = await import("../src/core/jsonl.js").then((mod) => mod.readJsonl<DocumentRecord>(path.join(workspacePath, "documents", "documents.jsonl")));

    expect(documents.map((document) => document.uri).sort()).toEqual([
      "https://example.com/",
      "https://example.com/pricing"
    ]);
    expect(fetchMock).not.toHaveBeenCalledWith("https://example.com/#about", expect.anything());
    expect(fetchMock).not.toHaveBeenCalledWith("https://example.com/#ideas", expect.anything());
  });

  it("skips query-string variants and xml endpoints during website crawling", async () => {
    const root = await tempWorkspace("qli-website-query-");
    const { workspacePath } = await ensureWorkspace({ workspacePath: path.join(root, ".kb") });
    const source = await addSource(workspacePath, {
      type: "website",
      uri: "https://example.com/",
      name: "Example",
      enabled: true,
      tags: ["site"],
      metadata: {},
      crawl: { maxDepth: 1, maxPages: 10, useSitemap: false, rateLimitMs: 0 },
      createdAt: "2026-05-18T00:00:00.000Z",
      updatedAt: "2026-05-18T00:00:00.000Z"
    });

    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "https://example.com/robots.txt") {
        return new Response("", { status: 404 });
      }
      if (url === "https://example.com/") {
        return new Response(`<!doctype html><html><head><title>Home</title></head><body><main>
          <a href="/pricing">Pricing</a>
          <a href="/?service=Starter">Starter</a>
          <a href="/podcast/index.xml">Podcast Feed</a>
          <a href="/guide.pdf">Guide PDF</a>
          <a href="/search/">Search</a>
          <a href="/cdn-cgi/l/email-protection">Email</a>
        </main></body></html>`, { status: 200, headers: { "content-type": "text/html" } });
      }
      if (url === "https://example.com/pricing") {
        return new Response(htmlPage("Pricing", "Plan details"), {
          status: 200,
          headers: { "content-type": "text/html" }
        });
      }
      throw new Error(`unexpected url ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    await ingestSources({ workspacePath, sourceIds: [source.id] });
    const documents = await import("../src/core/jsonl.js").then((mod) => mod.readJsonl<DocumentRecord>(path.join(workspacePath, "documents", "documents.jsonl")));

    expect(documents.map((document) => document.uri).sort()).toEqual([
      "https://example.com/",
      "https://example.com/pricing"
    ]);
    expect(fetchMock).not.toHaveBeenCalledWith("https://example.com/?service=Starter", expect.anything());
    expect(fetchMock).not.toHaveBeenCalledWith("https://example.com/podcast/index.xml", expect.anything());
    expect(fetchMock).not.toHaveBeenCalledWith("https://example.com/guide.pdf", expect.anything());
    expect(fetchMock).not.toHaveBeenCalledWith("https://example.com/search/", expect.anything());
    expect(fetchMock).not.toHaveBeenCalledWith("https://example.com/cdn-cgi/l/email-protection", expect.anything());
  });

  it("reuses pages fetched during website crawl discovery", async () => {
    const root = await tempWorkspace("qli-website-crawl-reuse-");
    const { workspacePath } = await ensureWorkspace({ workspacePath: path.join(root, ".kb") });
    const source = await addSource(workspacePath, {
      type: "website",
      uri: "https://example.com/",
      name: "Example",
      enabled: true,
      tags: ["site"],
      metadata: {},
      crawl: { maxDepth: 1, maxPages: 10, useSitemap: false, rateLimitMs: 0 },
      createdAt: "2026-05-18T00:00:00.000Z",
      updatedAt: "2026-05-18T00:00:00.000Z"
    });

    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "https://example.com/robots.txt") {
        return new Response("", { status: 404 });
      }
      if (url === "https://example.com/") {
        return new Response(`<!doctype html><html><head><title>Home</title></head><body><main>
          <a href="/one">One</a>
          <a href="/two">Two</a>
        </main></body></html>`, { status: 200, headers: { "content-type": "text/html" } });
      }
      return new Response(htmlPage(url.split("/").pop() ?? "Page", "Body"), {
        status: 200,
        headers: { "content-type": "text/html" }
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    await ingestSources({ workspacePath, sourceIds: [source.id] });

    const calls = fetchMock.mock.calls.map(([input]) => String(input));
    expect(calls.filter((url) => url === "https://example.com/")).toHaveLength(1);
    expect(calls.filter((url) => url === "https://example.com/one")).toHaveLength(1);
    expect(calls.filter((url) => url === "https://example.com/two")).toHaveLength(1);
  });

  it("indexes a canonical website page only once across aliases", async () => {
    const root = await tempWorkspace("qli-website-canonical-");
    const { workspacePath } = await ensureWorkspace({ workspacePath: path.join(root, ".kb") });
    const source = await addSource(workspacePath, {
      type: "website",
      uri: "https://example.com/",
      name: "Example",
      enabled: true,
      tags: ["site"],
      metadata: {},
      crawl: { maxDepth: 1, maxPages: 10, useSitemap: false, rateLimitMs: 0, maxConcurrentRequests: 1 },
      createdAt: "2026-05-18T00:00:00.000Z",
      updatedAt: "2026-05-18T00:00:00.000Z"
    });

    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "https://example.com/robots.txt") {
        return new Response("", { status: 404 });
      }
      if (url === "https://example.com/") {
        return new Response(`<!doctype html><html><head><title>Home</title></head><body><main>
          <a href="/offers/starter">Starter Alias</a>
          <a href="/services/starter">Starter Canonical</a>
        </main></body></html>`, { status: 200, headers: { "content-type": "text/html" } });
      }
      if (url === "https://example.com/offers/starter") {
        return new Response(`<!doctype html><html><head>
          <title>Starter Offer</title>
          <link rel="canonical" href="https://example.com/services/starter">
        </head><body><main><h1>Starter Offer</h1><p>Starter body</p></main></body></html>`, {
          status: 200,
          headers: { "content-type": "text/html" }
        });
      }
      if (url === "https://example.com/services/starter") {
        return new Response(`<!doctype html><html><head>
          <title>Starter Offer</title>
          <link rel="canonical" href="https://example.com/services/starter">
        </head><body><main><h1>Starter Offer</h1><p>Starter body</p></main></body></html>`, {
          status: 200,
          headers: { "content-type": "text/html" }
        });
      }
      throw new Error(`unexpected url ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await ingestSources({ workspacePath, sourceIds: [source.id] });
    const documents = await import("../src/core/jsonl.js").then((mod) => mod.readJsonl<DocumentRecord>(path.join(workspacePath, "documents", "documents.jsonl")));

    expect(result.documents.added).toBe(2);
    expect(documents.map((document) => document.uri).sort()).toEqual([
      "https://example.com/",
      "https://example.com/services/starter"
    ]);
    expect(documents.find((document) => document.uri === "https://example.com/services/starter")?.canonicalUri).toBe("https://example.com/services/starter");
  });

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

  it("fetches crawled website pages concurrently and respects the source concurrency limit", async () => {
    const root = await tempWorkspace("qli-website-concurrency-");
    const { workspacePath } = await ensureWorkspace({ workspacePath: path.join(root, ".kb") });
    const source = await addSource(workspacePath, {
      type: "website",
      uri: "https://example.com/",
      name: "Example",
      enabled: true,
      tags: ["site"],
      metadata: {},
      crawl: { maxDepth: 1, maxPages: 6, useSitemap: false, rateLimitMs: 0, maxConcurrentRequests: 2 },
      createdAt: "2026-05-18T00:00:00.000Z",
      updatedAt: "2026-05-18T00:00:00.000Z"
    });

    let inFlight = 0;
    let maxInFlight = 0;
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "https://example.com/robots.txt") {
        return new Response("", { status: 404 });
      }
      if (url === "https://example.com/") {
        return new Response(`<!doctype html><html><body>
          <a href="/one">One</a>
          <a href="/two">Two</a>
          <a href="/three">Three</a>
          <a href="/four">Four</a>
        </body></html>`, { status: 200, headers: { "content-type": "text/html" } });
      }
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 25));
      inFlight -= 1;
      return new Response(htmlPage(url.split("/").pop() ?? "Page", "Body"), {
        status: 200,
        headers: { "content-type": "text/html" }
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    await ingestSources({ workspacePath, sourceIds: [source.id] });

    expect(maxInFlight).toBe(2);
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

  it("fetches rss articles concurrently and respects the workspace default concurrency limit", async () => {
    const root = await tempWorkspace("qli-rss-concurrency-");
    const { workspacePath } = await ensureWorkspace({ workspacePath: path.join(root, ".kb") });
    await writeFile(path.join(workspacePath, "config.yaml"), "crawler:\n  maxConcurrentRequests: 3\n", "utf8");
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

    let inFlight = 0;
    let maxInFlight = 0;
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "https://example.com/feed.xml") {
        return new Response(rssFeed([
          "https://example.com/a",
          "https://example.com/b",
          "https://example.com/c",
          "https://example.com/d",
          "https://example.com/e"
        ]), { status: 200, headers: { "content-type": "application/rss+xml" } });
      }
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 25));
      inFlight -= 1;
      return new Response(htmlPage(url.split("/").pop() ?? "Item", "Story"), {
        status: 200,
        headers: { "content-type": "text/html" }
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    await ingestSources({ workspacePath, sourceIds: [source.id] });

    expect(maxInFlight).toBe(3);
  });
});
