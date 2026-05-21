import { load } from "cheerio";
import { mapWithConcurrency } from "../../core/concurrency.js";
import { reportProgress, type ProgressHandler } from "../../core/progress.js";
import { normalizeRemoteUrl } from "../../core/urls.js";
import type { Source } from "../../types/models.js";

async function fetchRobotsDisallow(url: URL, userAgent: string): Promise<string[]> {
  try {
    const response = await fetch(new URL("/robots.txt", url), { headers: { "user-agent": userAgent } });
    if (!response.ok) {
      return [];
    }
    const text = await response.text();
    return text
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => /^disallow:/i.test(line))
      .map((line) => line.split(":")[1]?.trim() ?? "")
      .filter((line) => line.length > 0);
  } catch {
    return [];
  }
}

async function fetchSitemapUrls(baseUrl: URL, userAgent: string): Promise<string[]> {
  try {
    const response = await fetch(new URL("/sitemap.xml", baseUrl), { headers: { "user-agent": userAgent } });
    if (!response.ok) {
      return [];
    }
    const xml = await response.text();
    return [...xml.matchAll(/<loc>(.*?)<\/loc>/g)].map((match) => match[1]!).filter(Boolean);
  } catch {
    return [];
  }
}

function isAllowed(url: URL, baseUrl: URL, includePatterns: string[], excludePatterns: string[], disallowRules: string[]): boolean {
  if (url.origin !== baseUrl.origin) {
    return false;
  }
  if (url.search.length > 0) {
    return false;
  }
  if (url.pathname.endsWith(".xml")) {
    return false;
  }
  if (url.pathname.includes("/cdn-cgi/")) {
    return false;
  }
  if (url.pathname === "/search" || url.pathname === "/search/" || url.pathname.endsWith("/search/")) {
    return false;
  }
  if (disallowRules.some((rule) => rule !== "/" && url.pathname.startsWith(rule))) {
    return false;
  }
  const href = url.href;
  if (includePatterns.length > 0 && !includePatterns.some((pattern) => href.includes(pattern))) {
    return false;
  }
  if (excludePatterns.some((pattern) => href.includes(pattern))) {
    return false;
  }
  return true;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function crawlWebsite(
  source: Source,
  defaults: {
    userAgent: string;
    rateLimitMs: number;
    maxConcurrentRequests: number;
  },
  progress?: ProgressHandler
): Promise<string[]> {
  const baseUrl = new URL(source.uri);
  const userAgent = source.crawl?.userAgent ?? defaults.userAgent;
  const includePatterns = source.crawl?.includePatterns ?? [];
  const excludePatterns = source.crawl?.excludePatterns ?? [];
  const maxDepth = source.crawl?.maxDepth ?? 2;
  const maxPages = source.crawl?.maxPages ?? 100;
  const rateLimitMs = source.crawl?.rateLimitMs ?? defaults.rateLimitMs;
  const maxConcurrentRequests = source.crawl?.maxConcurrentRequests ?? defaults.maxConcurrentRequests;
  const disallowRules = source.crawl?.obeyRobotsTxt === false ? [] : await fetchRobotsDisallow(baseUrl, userAgent);
  const seen = new Set<string>();
  const results: string[] = [];
  let currentLevel = [normalizeRemoteUrl(source.uri)];

  if (source.crawl?.useSitemap !== false) {
    const sitemapUrls = (await fetchSitemapUrls(baseUrl, userAgent)).map((url) => normalizeRemoteUrl(url));
    reportProgress(progress, `Discovered ${sitemapUrls.length} sitemap URL${sitemapUrls.length === 1 ? "" : "s"} for ${source.uri}`);
    currentLevel = [
      ...currentLevel,
      ...sitemapUrls
    ];
  }

  for (let depth = 0; depth <= maxDepth && currentLevel.length > 0 && results.length < maxPages; depth += 1) {
    reportProgress(progress, `Crawl depth ${depth}: evaluating ${currentLevel.length} candidate URL${currentLevel.length === 1 ? "" : "s"}`);
    const nextLevelCandidates: string[] = [];
    const allowedUrls: string[] = [];
    for (const candidate of currentLevel) {
      const normalizedCandidate = normalizeRemoteUrl(candidate);
      if (seen.has(normalizedCandidate)) {
        continue;
      }
      seen.add(normalizedCandidate);
      const url = new URL(normalizedCandidate);
      if (!isAllowed(url, baseUrl, includePatterns, excludePatterns, disallowRules)) {
        continue;
      }
      allowedUrls.push(normalizedCandidate);
      results.push(normalizedCandidate);
      reportProgress(progress, `Discovered ${normalizedCandidate}`);
      if (results.length >= maxPages) {
        break;
      }
    }

    reportProgress(progress, `Crawl depth ${depth}: queued ${allowedUrls.length} page${allowedUrls.length === 1 ? "" : "s"} for link extraction`);

    if (depth >= maxDepth || results.length >= maxPages) {
      break;
    }

    await mapWithConcurrency(allowedUrls, maxConcurrentRequests, async (pageUrl) => {
      const page = new URL(pageUrl);
      const response = await fetch(page, { headers: { "user-agent": userAgent } });
      const html = await response.text();
      const $ = load(html);
      $("a[href]").each((_, element) => {
        const href = $(element).attr("href");
        if (!href) {
          return;
        }
        try {
          nextLevelCandidates.push(normalizeRemoteUrl(new URL(href, page).href));
        } catch {
          // ignore bad links
        }
      });
      if (rateLimitMs > 0) {
        await delay(rateLimitMs);
      }
    });

    currentLevel = nextLevelCandidates;
  }
  return results;
}
