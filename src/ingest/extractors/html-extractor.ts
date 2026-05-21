import { load } from "cheerio";
import TurndownService from "turndown";
import { stripBoilerplate } from "../../normalize/boilerplate.js";

const turndown = new TurndownService({ headingStyle: "atx", codeBlockStyle: "fenced" });

const LOW_SIGNAL_SECTION_SELECTORS = [
  "script",
  "style",
  "noscript",
  "template",
  "[data-blog-service-recommendations]",
  "[data-blog-related-posts]"
].join(", ");

function cleanText(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function pruneLowSignalContent($: ReturnType<typeof load>): void {
  $(LOW_SIGNAL_SECTION_SELECTORS).remove();

  $("form").each((_, element) => {
    const action = cleanText($(element).attr("action") ?? "");
    if (action.includes("substack.com/subscribe")) {
      $(element).closest("section").remove();
    }
  });
}

function stripEscapedJsonPayloads(markdown: string): string {
  return markdown
    .split("\n")
    .filter((line) => {
      const trimmed = line.trim();
      if (trimmed.length === 0) {
        return true;
      }
      if (trimmed.length > 300 && /^"?\\?\[\{\\?"[a-z0-9_]+\\?":/i.test(trimmed)) {
        return false;
      }
      if (trimmed.length > 300 && trimmed.includes('\\"permalink\\":') && trimmed.includes('\\"title\\":')) {
        return false;
      }
      return true;
    })
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function chooseMeaningfulTitle($: ReturnType<typeof load>, fallbackTitle: string): string {
  const candidates = [
    cleanText($("meta[property='og:title']").attr("content") ?? ""),
    cleanText($("meta[name='twitter:title']").attr("content") ?? ""),
    cleanText($("h1").first().text()),
    cleanText($("title").first().text()),
    fallbackTitle
  ].filter(Boolean);
  return candidates[0] ?? fallbackTitle;
}

turndown.addRule("docCard", {
  filter(node) {
    return node.nodeName === "A"
      && typeof (node as Element).getAttribute === "function"
      && (((node as Element).getAttribute("class") ?? "").split(/\s+/).includes("doc-card"));
  },
  replacement(_content, node) {
    const element = node as Element;
    const href = cleanText(element.getAttribute("href") ?? "");
    const title = cleanText(element.querySelector("h3")?.textContent ?? "");
    const summary = cleanText(element.querySelector("p")?.textContent ?? "");
    const section = cleanText(element.querySelector("span")?.textContent ?? "");
    const parts = [
      title ? `### ${title}` : "",
      summary,
      section,
      href
    ].filter(Boolean);
    return `\n\n${parts.join("\n\n")}\n\n`;
  }
});

export function extractHtmlToMarkdown(html: string): { markdown: string; title: string } {
  const cleaned = stripBoilerplate(html);
  const $ = load(cleaned);
  pruneLowSignalContent($);
  const fallbackTitle = cleanText($("title").first().text()) || "Untitled";
  const title = chooseMeaningfulTitle($, fallbackTitle);
  const root = $("main").first().html() ?? $.root().html() ?? cleaned;
  return {
    markdown: stripEscapedJsonPayloads(turndown.turndown(root)),
    title
  };
}

export function extractCanonicalUriFromHtml(html: string, baseUrl: string): string | null {
  const $ = load(html);
  const href = $("link[rel='canonical']").first().attr("href")?.trim();
  if (!href) {
    return null;
  }
  try {
    return new URL(href, baseUrl).href;
  } catch {
    return null;
  }
}

function parseDateCandidate(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }
  const date = new Date(trimmed);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

export function extractPublicationDateFromHtml(html: string): string | null {
  const $ = load(html);
  const candidates = [
    $("meta[property='article:published_time']").attr("content"),
    $("meta[property='og:published_time']").attr("content"),
    $("meta[name='pubdate']").attr("content"),
    $("meta[name='publish-date']").attr("content"),
    $("meta[name='article:published_time']").attr("content"),
    $("meta[name='date']").attr("content"),
    $("time[datetime]").first().attr("datetime")
  ].filter((value): value is string => Boolean(value?.trim()));

  for (const candidate of candidates) {
    const parsed = parseDateCandidate(candidate);
    if (parsed) {
      return parsed;
    }
  }

  let jsonLdDate: string | null = null;
  $('script[type="application/ld+json"]').each((_, element) => {
    if (jsonLdDate) {
      return false;
    }
    try {
      const raw = $(element).text();
      const parsed = JSON.parse(raw) as unknown;
      const queue = Array.isArray(parsed) ? [...parsed] : [parsed];
      while (queue.length > 0) {
        const next = queue.shift();
        if (!next || typeof next !== "object") {
          continue;
        }
        const record = next as Record<string, unknown>;
        for (const key of ["datePublished", "dateCreated", "dateModified"]) {
          if (typeof record[key] === "string") {
            const normalized = parseDateCandidate(record[key]);
            if (normalized) {
              jsonLdDate = normalized;
              return false;
            }
          }
        }
        if (Array.isArray(record["@graph"])) {
          queue.push(...record["@graph"]);
        }
      }
    } catch (error) {
      void error;
    }
    return undefined;
  });

  return jsonLdDate;
}
