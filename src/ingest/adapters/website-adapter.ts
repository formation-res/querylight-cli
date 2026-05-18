import { load } from "cheerio";
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

export async function crawlWebsite(source: Source): Promise<string[]> {
  const baseUrl = new URL(source.uri);
  const userAgent = source.crawl?.userAgent ?? "querylight-cli/0.1";
  const includePatterns = source.crawl?.includePatterns ?? [];
  const excludePatterns = source.crawl?.excludePatterns ?? [];
  const maxDepth = source.crawl?.maxDepth ?? 2;
  const maxPages = source.crawl?.maxPages ?? 100;
  const rateLimitMs = source.crawl?.rateLimitMs ?? 1000;
  const disallowRules = source.crawl?.obeyRobotsTxt === false ? [] : await fetchRobotsDisallow(baseUrl, userAgent);
  const queue: Array<{ url: string; depth: number }> = [{ url: source.uri, depth: 0 }];
  const seen = new Set<string>();
  const results: string[] = [];

  if (source.crawl?.useSitemap !== false) {
    for (const url of await fetchSitemapUrls(baseUrl, userAgent)) {
      queue.push({ url, depth: 1 });
    }
  }

  while (queue.length > 0 && results.length < maxPages) {
    const next = queue.shift();
    if (!next || seen.has(next.url)) {
      continue;
    }
    seen.add(next.url);
    const url = new URL(next.url);
    if (!isAllowed(url, baseUrl, includePatterns, excludePatterns, disallowRules)) {
      continue;
    }
    results.push(url.href);
    if (next.depth >= maxDepth) {
      continue;
    }
    const response = await fetch(url, { headers: { "user-agent": userAgent } });
    const html = await response.text();
    const $ = load(html);
    $("a[href]").each((_, element) => {
      const href = $(element).attr("href");
      if (!href) {
        return;
      }
      try {
        const target = new URL(href, url);
        if (!seen.has(target.href)) {
          queue.push({ url: target.href, depth: next.depth + 1 });
        }
      } catch {
        // ignore bad links
      }
    });
    if (rateLimitMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, rateLimitMs));
    }
  }
  return results;
}
