import { load } from "cheerio";
import TurndownService from "turndown";
import { stripBoilerplate } from "../../normalize/boilerplate.js";

const turndown = new TurndownService({ headingStyle: "atx", codeBlockStyle: "fenced" });

function cleanText(value: string): string {
  return value.replace(/\s+/g, " ").trim();
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
  const fallbackTitle = cleanText($("title").first().text()) || "Untitled";
  const title = chooseMeaningfulTitle($, fallbackTitle);
  const root = $("main").first().html() ?? $.root().html() ?? cleaned;
  return {
    markdown: turndown.turndown(root),
    title
  };
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
