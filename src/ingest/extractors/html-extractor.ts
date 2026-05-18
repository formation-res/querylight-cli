import { load } from "cheerio";
import TurndownService from "turndown";
import { stripBoilerplate } from "../../normalize/boilerplate.js";

const turndown = new TurndownService({ headingStyle: "atx", codeBlockStyle: "fenced" });

export function extractHtmlToMarkdown(html: string): { markdown: string; title: string } {
  const cleaned = stripBoilerplate(html);
  const $ = load(cleaned);
  const title = $("h1").first().text().trim() || $("title").first().text().trim() || "Untitled";
  const root = $("main").first().html() ?? $.root().html() ?? cleaned;
  return {
    markdown: turndown.turndown(root),
    title
  };
}
