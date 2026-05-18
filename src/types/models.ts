export type SourceType =
  | "url"
  | "website"
  | "file"
  | "directory"
  | "markdown"
  | "text";

export type PrimitiveMetadata = string | number | boolean | string[];
export type Metadata = Record<string, PrimitiveMetadata>;

export type CrawlConfig = {
  maxDepth?: number;
  maxPages?: number;
  includePatterns?: string[];
  excludePatterns?: string[];
  obeyRobotsTxt?: boolean;
  userAgent?: string;
  rateLimitMs?: number;
  useSitemap?: boolean;
  renderJs?: boolean;
};

export type Source = {
  id: string;
  type: SourceType;
  name: string;
  uri: string;
  enabled: boolean;
  tags: string[];
  metadata: Metadata;
  crawl?: CrawlConfig;
  createdAt: string;
  updatedAt: string;
};

export type DocumentRecord = {
  id: string;
  sourceId: string;
  sourceType: SourceType;
  title: string;
  uri: string;
  canonicalUri?: string;
  mimeType: string;
  language?: string;
  rawPath?: string;
  normalizedPath: string;
  contentHash: string;
  metadata: Metadata;
  firstSeenAt: string;
  lastSeenAt: string;
  lastChangedAt: string;
  indexedAt?: string;
};

export type ChunkRecord = {
  id: string;
  documentId: string;
  sourceId: string;
  title: string;
  uri: string;
  headingPath: string[];
  text: string;
  tokenEstimate?: number;
  contentHash: string;
  metadata: Metadata;
  firstSeenAt: string;
  lastSeenAt: string;
  lastChangedAt: string;
};

export type IndexMetadata = {
  id: string;
  createdAt: string;
  querylightVersion: string;
  kbVersion: string;
  documentCount: number;
  chunkCount: number;
  sourceCount: number;
  fields: string[];
  embeddingModel?: string;
  sparseVectorModel?: string;
  indexHash: string;
};

export type WorkspaceConfig = {
  workspaceVersion: number;
  index: {
    name: string;
    fields: Record<string, { type: string; weight?: number }>;
    chunking: {
      maxChars: number;
      overlapChars: number;
      minChars: number;
      splitOnHeadings: boolean;
    };
  };
  rag: {
    defaultTopK: number;
    maxContextChars: number;
    citationStyle: "markdown";
  };
  crawler: {
    defaultUserAgent: string;
    obeyRobotsTxt: boolean;
    rateLimitMs: number;
    renderJs: boolean;
  };
  limits: {
    maxFileSizeMb: number;
    maxPagesPerSource: number;
    maxTotalChunks: number;
  };
};

export type CommandError = {
  code: string;
  message: string;
  details?: unknown;
};

export type CommandResponse<T> = {
  ok: boolean;
  command: string;
  workspace: string;
  version: string;
  data?: T;
  error?: CommandError;
};

export type SearchResult = {
  chunkId: string;
  documentId: string;
  sourceId: string;
  score: number;
  title: string;
  uri: string;
  headingPath: string[];
  snippet: string;
  text?: string;
  metadata: Record<string, unknown>;
};

export type SearchResponseData = {
  results: SearchResult[];
};

export type ContextSource = {
  chunkId: string;
  documentId: string;
  sourceId: string;
  title: string;
  uri: string;
  headingPath: string[];
  text: string;
  metadata: Record<string, unknown>;
};

export type ContextResponseData = {
  markdown: string;
  sources: ContextSource[];
};

export type RunRecord = {
  id: string;
  kind: string;
  createdAt: string;
  success: boolean;
  summary: Record<string, unknown>;
  documentsSnapshot?: Array<{
    id: string;
    title: string;
    uri: string;
    contentHash: string;
    lastChangedAt: string;
    sourceId: string;
  }>;
};
