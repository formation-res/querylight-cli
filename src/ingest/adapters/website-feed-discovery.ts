import { load } from "cheerio";
import type { Source } from "../../types/models.js";
import { parseRssFeedDocument } from "./rss-adapter.js";

type FeedCandidate = {
  url: string;
  discoveredBy: "declared" | "common";
  order: number;
  typeHint?: string;
};

export type WebsiteFeedDiscovery = {
  feedUrl: string;
  discoveredBy: "declared" | "common";
  excludePrefix?: string;
};

const COMMON_FEED_PATHS = [
  "/feed",
  "/feed.xml",
  "/rss",
  "/rss.xml",
  "/atom.xml",
  "/index.xml",
  "/blog/feed",
  "/blog/feed.xml",
  "/blog/rss.xml",
  "/blog/atom.xml",
  "/blog/index.xml",
  "/news/feed",
  "/news/feed.xml",
  "/news/rss.xml",
  "/news/atom.xml",
  "/news/index.xml"
] as const;

function normalizeCandidateUrl(href: string, baseUrl: URL): string | null {
  try {
    const resolved = new URL(href, baseUrl);
    if (!["http:", "https:"].includes(resolved.protocol)) {
      return null;
    }
    return resolved.href;
  } catch {
    return null;
  }
}

function looksLikeFeedLink(typeHint: string | undefined, href: string): boolean {
  const type = typeHint?.toLowerCase() ?? "";
  const lowerHref = href.toLowerCase();
  return type.includes("rss")
    || type.includes("atom")
    || type.includes("xml")
    || lowerHref.includes("/feed")
    || lowerHref.includes("/rss")
    || lowerHref.includes("/atom")
    || lowerHref.endsWith(".xml");
}

function extractDeclaredFeedCandidates(html: string, baseUrl: URL): FeedCandidate[] {
  const $ = load(html);
  const candidates: FeedCandidate[] = [];
  $("link[href]").each((index, element) => {
    const rel = ($(element).attr("rel") ?? "")
      .split(/\s+/)
      .map((value) => value.trim().toLowerCase())
      .filter(Boolean);
    const href = $(element).attr("href");
    if (!href || !rel.includes("alternate")) {
      return;
    }
    const typeHint = $(element).attr("type") ?? undefined;
    if (!looksLikeFeedLink(typeHint, href)) {
      return;
    }
    const normalized = normalizeCandidateUrl(href, baseUrl);
    if (!normalized) {
      return;
    }
    candidates.push({
      url: normalized,
      discoveredBy: "declared",
      order: index,
      typeHint
    });
  });
  return candidates;
}

function buildCommonFeedCandidates(baseUrl: URL): FeedCandidate[] {
  return COMMON_FEED_PATHS.map((pathname, index) => ({
    url: new URL(pathname, baseUrl).href,
    discoveredBy: "common" as const,
    order: index
  }));
}

function dedupeCandidates(candidates: FeedCandidate[]): FeedCandidate[] {
  const seen = new Set<string>();
  const deduped: FeedCandidate[] = [];
  for (const candidate of candidates) {
    if (seen.has(candidate.url)) {
      continue;
    }
    seen.add(candidate.url);
    deduped.push(candidate);
  }
  return deduped;
}

function looksLikeFeedDocument(contentType: string | null, body: string): boolean {
  const type = contentType?.toLowerCase() ?? "";
  const lowerBody = body.toLowerCase();
  return type.includes("rss")
    || type.includes("atom")
    || (type.includes("xml") && (lowerBody.includes("<rss") || lowerBody.includes("<feed") || lowerBody.includes("<rdf:rdf")))
    || lowerBody.includes("<rss")
    || lowerBody.includes("<feed")
    || lowerBody.includes("<rdf:rdf");
}

function hasStablePrefixSegment(segment: string | undefined): segment is string {
  return typeof segment === "string" && segment.length > 0 && /[a-z]/i.test(segment);
}

function deriveExcludePrefix(itemUrls: string[], websiteOrigin: string): string | undefined {
  const paths = itemUrls
    .map((itemUrl) => {
      try {
        const parsed = new URL(itemUrl);
        if (parsed.origin !== websiteOrigin) {
          return null;
        }
        return parsed.pathname.split("/").filter(Boolean);
      } catch {
        return null;
      }
    })
    .filter((segments: string[] | null): segments is string[] => Array.isArray(segments));

  if (paths.length < 2) {
    return undefined;
  }

  const first = paths[0];
  if (!first) {
    return undefined;
  }

  let commonLength = 0;
  while (commonLength < first.length) {
    const nextSegment = first[commonLength];
    if (!hasStablePrefixSegment(nextSegment) || !paths.every((segments) => segments[commonLength] === nextSegment)) {
      break;
    }
    commonLength += 1;
  }

  if (commonLength === 0) {
    return undefined;
  }

  return `/${first.slice(0, commonLength).join("/")}/`;
}

function scoreCandidate(candidate: FeedCandidate): number {
  const url = new URL(candidate.url);
  const segments = url.pathname.split("/").filter(Boolean);
  let score = candidate.discoveredBy === "declared" ? 1_000 : 100;
  score -= candidate.order;
  score -= segments.length * 10;
  if (candidate.typeHint?.toLowerCase().includes("rss") || candidate.typeHint?.toLowerCase().includes("atom")) {
    score += 25;
  }
  if (["/feed", "/feed.xml", "/rss", "/rss.xml", "/atom.xml", "/index.xml"].includes(url.pathname)) {
    score += 50;
  }
  if (url.pathname.includes("comments")) {
    score -= 200;
  }
  return score;
}

async function validateCandidate(candidate: FeedCandidate, websiteUrl: URL, userAgent: string): Promise<WebsiteFeedDiscovery | null> {
  try {
    const response = await fetch(candidate.url, { headers: { "user-agent": userAgent } });
    if (!response.ok) {
      return null;
    }
    const body = await response.text();
    if (!looksLikeFeedDocument(response.headers.get("content-type"), body)) {
      return null;
    }
    const source: Source = {
      id: "src_detected_feed",
      type: "rss",
      uri: candidate.url,
      name: "Detected Feed",
      enabled: true,
      tags: [],
      metadata: {},
      createdAt: "1970-01-01T00:00:00.000Z",
      updatedAt: "1970-01-01T00:00:00.000Z"
    };
    const items = await parseRssFeedDocument(body, source);
    return {
      feedUrl: candidate.url,
      discoveredBy: candidate.discoveredBy,
      excludePrefix: deriveExcludePrefix(items.map((item) => item.url), websiteUrl.origin)
    };
  } catch {
    return null;
  }
}

export async function discoverWebsiteFeed(websiteUrl: string, userAgent: string): Promise<WebsiteFeedDiscovery | null> {
  try {
    const baseUrl = new URL(websiteUrl);
    const response = await fetch(baseUrl, { headers: { "user-agent": userAgent } });
    if (!response.ok) {
      return null;
    }
    const html = await response.text();
    const candidates = dedupeCandidates([
      ...extractDeclaredFeedCandidates(html, baseUrl),
      ...buildCommonFeedCandidates(baseUrl)
    ]).sort((left, right) => scoreCandidate(right) - scoreCandidate(left));

    for (const candidate of candidates) {
      const validated = await validateCandidate(candidate, baseUrl, userAgent);
      if (validated) {
        return validated;
      }
    }
    return null;
  } catch {
    return null;
  }
}
