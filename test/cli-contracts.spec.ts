import path from "node:path";
import { readFile } from "node:fs/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runCli } from "../src/cli/run-cli.js";
import { readJsonl } from "../src/core/jsonl.js";
import type { Source } from "../src/types/models.js";
import { cleanupTempDirs, tempWorkspace } from "./helpers.js";

afterEach(async () => {
  vi.restoreAllMocks();
  await cleanupTempDirs();
});

function websiteHtml(feedLinks: string[] = []): string {
  const links = feedLinks
    .map((href) => `<link rel="alternate" type="application/rss+xml" href="${href}">`)
    .join("");
  return `<!doctype html><html><head><title>Example</title>${links}</head><body><h1>Example</h1></body></html>`;
}

function rssFeed(itemUrls: string[]): string {
  const items = itemUrls
    .map((url, index) => `<item><title>Item ${index + 1}</title><link>${url}</link><pubDate>Mon, 01 Jan 2024 00:00:00 GMT</pubDate></item>`)
    .join("");
  return `<?xml version="1.0"?><rss version="2.0"><channel><title>Feed</title>${items}</channel></rss>`;
}

describe("cli contracts", () => {
  it("returns structured json errors for invalid metadata arguments", async () => {
    const root = await tempWorkspace("qli-cli-");
    const workspace = path.join(root, ".kb");
    await runCli(["init", "--workspace", workspace]);

    const result = await runCli([
      "source",
      "add",
      "directory",
      path.resolve("test-fixtures/docs"),
      "--workspace",
      workspace,
      "--name",
      "Docs",
      "--metadata",
      "invalid",
      "--json"
    ]);

    expect(result.exitCode).toBe(2);
    const parsed = JSON.parse(result.stderr);
    expect(parsed.ok).toBe(false);
    expect(parsed.error.code).toBe("INVALID_ARGUMENT");
  });

  it("supports source disable and enable through the cli", async () => {
    const root = await tempWorkspace("qli-cli-");
    const workspace = path.join(root, ".kb");
    await runCli(["init", "--workspace", workspace]);
    const added = await runCli([
      "source",
      "add",
      "directory",
      path.resolve("test-fixtures/docs"),
      "--workspace",
      workspace,
      "--name",
      "Docs",
      "--json"
    ]);
    const sourceId = JSON.parse(added.stdout).data.id as string;

    const disabled = await runCli(["source", "disable", sourceId, "--workspace", workspace, "--json"]);
    expect(JSON.parse(disabled.stdout).data.enabled).toBe(false);

    const enabled = await runCli(["source", "enable", sourceId, "--workspace", workspace, "--json"]);
    expect(JSON.parse(enabled.stdout).data.enabled).toBe(true);
  });

  it("stores rss retention and concurrency per feed and edits them through source config", async () => {
    const root = await tempWorkspace("qli-cli-");
    const workspace = path.join(root, ".kb");
    await runCli(["init", "--workspace", workspace]);

    const added = await runCli([
      "source",
      "add",
      "rss",
      "https://example.com/feed.xml",
      "--workspace",
      workspace,
      "--name",
      "Feed",
      "--max-concurrent-requests",
      "3",
      "--json"
    ]);
    const addedParsed = JSON.parse(added.stdout);
    expect(addedParsed.data.crawl.retentionDays).toBe(365);
    expect(addedParsed.data.crawl.maxConcurrentRequests).toBe(3);
    expect(addedParsed.data.crawl.fetchArticles).toBe(true);

    const updated = await runCli([
      "source",
      "config",
      addedParsed.data.id,
      "--workspace",
      workspace,
      "--retention-days",
      "30",
      "--max-concurrent-requests",
      "2",
      "--metadata",
      "team=docs",
      "--json"
    ]);
    const updatedParsed = JSON.parse(updated.stdout);
    expect(updatedParsed.data.crawl.retentionDays).toBe(30);
    expect(updatedParsed.data.crawl.maxConcurrentRequests).toBe(2);
    expect(updatedParsed.data.crawl.fetchArticles).toBe(true);
    expect(updatedParsed.data.metadata.team).toBe("docs");

    const stored = await readFile(path.join(workspace, "sources", "sources.jsonl"), "utf8");
    expect(stored).toContain("\"retentionDays\":30");
    expect(stored).toContain("\"maxConcurrentRequests\":2");
  });

  it("returns status and doctor json envelopes", async () => {
    const root = await tempWorkspace("qli-cli-");
    const workspace = path.join(root, ".kb");
    await runCli(["init", "--workspace", workspace]);

    const status = await runCli(["status", "--workspace", workspace, "--json"]);
    const statusParsed = JSON.parse(status.stdout);
    expect(statusParsed.ok).toBe(true);
    expect(statusParsed.data.sources).toBe(0);

    const doctor = await runCli(["doctor", "--workspace", workspace, "--json"]);
    const doctorParsed = JSON.parse(doctor.stdout);
    expect(doctorParsed.ok).toBe(true);
    expect(doctorParsed.data.checks).toContain("config parses");
  });

  it("auto-adds a declared feed for website sources and returns a composite payload", async () => {
    const root = await tempWorkspace("qli-cli-");
    const workspace = path.join(root, ".kb");
    await runCli(["init", "--workspace", workspace]);

    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "https://example.com/") {
        return new Response(websiteHtml(["/feed.xml"]), { status: 200, headers: { "content-type": "text/html" } });
      }
      if (url === "https://example.com/feed.xml") {
        return new Response(rssFeed([
          "https://example.com/blog/post-one",
          "https://example.com/blog/post-two"
        ]), { status: 200, headers: { "content-type": "application/rss+xml" } });
      }
      throw new Error(`unexpected url ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const added = await runCli([
      "source",
      "add",
      "website",
      "https://example.com/",
      "--workspace",
      workspace,
      "--name",
      "Example Site",
      "--json"
    ]);
    const parsed = JSON.parse(added.stdout);

    expect(parsed.data.primarySource.type).toBe("website");
    expect(parsed.data.addedSources).toHaveLength(2);
    expect(parsed.data.detectedFeed.url).toBe("https://example.com/feed.xml");
    expect(parsed.data.detectedFeed.excludePrefix).toBe("/blog/");

    const sources = await readJsonl<Source>(path.join(workspace, "sources", "sources.jsonl"));
    expect(sources).toHaveLength(2);
    expect(sources.find((source) => source.type === "website")?.crawl?.excludePatterns).toContain("/blog/");
    expect(sources.find((source) => source.type === "rss")?.uri).toBe("https://example.com/feed.xml");
  });

  it("falls back to common feed paths when no declared feed link exists", async () => {
    const root = await tempWorkspace("qli-cli-");
    const workspace = path.join(root, ".kb");
    await runCli(["init", "--workspace", workspace]);

    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "https://example.com/") {
        return new Response(websiteHtml(), { status: 200, headers: { "content-type": "text/html" } });
      }
      if (url === "https://example.com/feed") {
        return new Response(rssFeed([
          "https://example.com/news/post-one",
          "https://example.com/news/post-two"
        ]), { status: 200, headers: { "content-type": "application/rss+xml" } });
      }
      return new Response("not found", { status: 404, headers: { "content-type": "text/plain" } });
    });
    vi.stubGlobal("fetch", fetchMock);

    const added = await runCli([
      "source",
      "add",
      "website",
      "https://example.com/",
      "--workspace",
      workspace,
      "--name",
      "Example Site",
      "--json"
    ]);
    const parsed = JSON.parse(added.stdout);

    expect(parsed.data.detectedFeed.url).toBe("https://example.com/feed");
    expect(parsed.data.detectedFeed.discoveredBy).toBe("common");
  });

  it("chooses the highest-ranked feed when multiple plausible feeds exist", async () => {
    const root = await tempWorkspace("qli-cli-");
    const workspace = path.join(root, ".kb");
    await runCli(["init", "--workspace", workspace]);

    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "https://example.com/") {
        return new Response(websiteHtml(["/blog/feed.xml", "/feed.xml"]), { status: 200, headers: { "content-type": "text/html" } });
      }
      if (url === "https://example.com/feed.xml") {
        return new Response(rssFeed([
          "https://example.com/blog/post-one",
          "https://example.com/blog/post-two"
        ]), { status: 200, headers: { "content-type": "application/rss+xml" } });
      }
      if (url === "https://example.com/blog/feed.xml") {
        return new Response(rssFeed([
          "https://example.com/blog/post-three",
          "https://example.com/blog/post-four"
        ]), { status: 200, headers: { "content-type": "application/rss+xml" } });
      }
      throw new Error(`unexpected url ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const added = await runCli([
      "source",
      "add",
      "website",
      "https://example.com/",
      "--workspace",
      workspace,
      "--name",
      "Example Site",
      "--json"
    ]);
    const parsed = JSON.parse(added.stdout);

    expect(parsed.data.detectedFeed.url).toBe("https://example.com/feed.xml");
    expect(parsed.data.addedSources).toHaveLength(2);
  });

  it("does not add an exclusion prefix when feed item URLs do not share a stable path prefix", async () => {
    const root = await tempWorkspace("qli-cli-");
    const workspace = path.join(root, ".kb");
    await runCli(["init", "--workspace", workspace]);

    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "https://example.com/") {
        return new Response(websiteHtml(["/feed.xml"]), { status: 200, headers: { "content-type": "text/html" } });
      }
      if (url === "https://example.com/feed.xml") {
        return new Response(rssFeed([
          "https://example.com/alpha/post-one",
          "https://example.com/beta/post-two"
        ]), { status: 200, headers: { "content-type": "application/rss+xml" } });
      }
      throw new Error(`unexpected url ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const added = await runCli([
      "source",
      "add",
      "website",
      "https://example.com/",
      "--workspace",
      workspace,
      "--name",
      "Example Site",
      "--json"
    ]);
    const parsed = JSON.parse(added.stdout);

    expect(parsed.data.detectedFeed.excludePrefix).toBeUndefined();
    const sources = await readJsonl<Source>(path.join(workspace, "sources", "sources.jsonl"));
    expect(sources.find((source) => source.type === "website")?.crawl?.excludePatterns ?? []).toEqual([]);
  });

  it("ignores invalid common feed URLs without failing website registration", async () => {
    const root = await tempWorkspace("qli-cli-");
    const workspace = path.join(root, ".kb");
    await runCli(["init", "--workspace", workspace]);

    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "https://example.com/") {
        return new Response(websiteHtml(), { status: 200, headers: { "content-type": "text/html" } });
      }
      if (url === "https://example.com/feed") {
        return new Response("<html>not a feed</html>", { status: 200, headers: { "content-type": "text/html" } });
      }
      return new Response("not found", { status: 404, headers: { "content-type": "text/plain" } });
    });
    vi.stubGlobal("fetch", fetchMock);

    const added = await runCli([
      "source",
      "add",
      "website",
      "https://example.com/",
      "--workspace",
      workspace,
      "--name",
      "Example Site",
      "--json"
    ]);
    const parsed = JSON.parse(added.stdout);

    expect(parsed.data.primarySource.type).toBe("website");
    expect(parsed.data.addedSources).toHaveLength(1);
    expect(parsed.data.detectedFeed).toBeNull();
  });
});
