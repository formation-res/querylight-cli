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
