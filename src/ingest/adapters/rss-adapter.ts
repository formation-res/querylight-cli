import { Readable } from "node:stream";
import FeedParser from "feedparser";
import { parseFeed } from "feedsmith";
import type { Source } from "../../types/models.js";

export type ParsedFeedItem = {
  url: string;
  title: string;
  publicationDate: string | null;
};

function toIsoDate(value: unknown): string | null {
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value.toISOString();
  }
  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
  }
  return null;
}

function normalizeFeedLink(link: string | undefined, baseUrl: string): string | null {
  if (!link?.trim()) {
    return null;
  }
  try {
    return new URL(link, baseUrl).href;
  } catch {
    return null;
  }
}

function normalizeFeedsmithItems(feed: any, baseUrl: string): ParsedFeedItem[] {
  const items = Array.isArray(feed?.items) ? feed.items : Array.isArray(feed?.entries) ? feed.entries : [];
  return items
    .map((item: any) => {
      const link = normalizeFeedLink(
        item?.link
          ?? item?.url
          ?? item?.id
          ?? item?.guid
          ?? item?.links?.[0]?.href
          ?? item?.links?.[0]?.href,
        baseUrl
      );
      if (!link) {
        return null;
      }
      return {
        url: link,
        title: String(item?.title ?? item?.summary ?? link).trim(),
        publicationDate: toIsoDate(
          item?.pubDate
            ?? item?.published
            ?? item?.updated
            ?? item?.published_at
            ?? item?.date_published
            ?? item?.dc?.date
        )
      };
    })
    .filter((item: ParsedFeedItem | null): item is ParsedFeedItem => item !== null);
}

async function parseWithFeedparser(xml: string, feedUrl: string): Promise<ParsedFeedItem[]> {
  const parser = new FeedParser({ feedurl: feedUrl });
  const items: ParsedFeedItem[] = [];

  return await new Promise<ParsedFeedItem[]>((resolve, reject) => {
    parser.on("error", reject);
    parser.on("readable", function onReadable(this: FeedParser) {
      let item: FeedParser.Item | null;
      while ((item = this.read())) {
        const link = normalizeFeedLink(item.link || item.origlink, feedUrl);
        if (!link) {
          continue;
        }
        items.push({
          url: link,
          title: String(item.title ?? link).trim(),
          publicationDate: toIsoDate(item.pubdate ?? item.date)
        });
      }
    });
    parser.on("end", () => resolve(items));
    Readable.from([xml]).pipe(parser);
  });
}

export async function parseRssFeedDocument(
  xml: string,
  source: Source
): Promise<ParsedFeedItem[]> {
  try {
    const parsed = parseFeed(xml);
    return normalizeFeedsmithItems(parsed.feed, source.uri);
  } catch {
    return parseWithFeedparser(xml, source.uri);
  }
}
