export type SourceType =
  | "url"
  | "website"
  | "rss"
  | "file"
  | "directory"
  | "markdown"
  | "text";

export type PrimitiveMetadata = string | number | boolean | string[] | null;
export type Metadata = Record<string, PrimitiveMetadata>;
export type RetrievalMode = "lexical" | "dense" | "sparse" | "hybrid";

export type CrawlConfig = {
  maxDepth?: number;
  maxPages?: number;
  maxConcurrentRequests?: number;
  includePatterns?: string[];
  excludePatterns?: string[];
  obeyRobotsTxt?: boolean;
  userAgent?: string;
  rateLimitMs?: number;
  useSitemap?: boolean;
  renderJs?: boolean;
  retentionDays?: number;
  fetchArticles?: boolean;
};

export type HttpCacheMetadata = {
  etag?: string;
  lastModified?: string;
  cacheControl?: string;
  expires?: string | null;
  lastValidatedAt?: string;
  lastStatus?: number;
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
  sourceUri: string;
  canonicalUri?: string;
  mimeType: string;
  language?: string;
  rawPath?: string;
  normalizedPath: string;
  contentHash: string;
  metadata: Metadata;
  publicationDate?: string | null;
  crawledAt?: string;
  firstSeenAt: string;
  lastSeenAt: string;
  lastChangedAt: string;
  indexedAt?: string;
  httpCache?: HttpCacheMetadata;
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

export type DenseVectorModelConfig = {
  enabled: boolean;
  modelId: string;
  cacheDir: string;
  indexHashTables: number;
  indexRandomSeed: number;
  chunkTextMode: "title-heading-text";
};

export type SparseVectorModelConfig = {
  enabled: boolean;
  modelId: string;
  cacheDir: string;
  documentTopTokens: number;
  queryEncoding: "tokenizer-token-weights";
  documentEncoding: "masked-lm-max-log1p-relu";
  chunkTextMode: "title-heading-text";
};

export type DenseVectorMetadata = {
  createdAt: string;
  modelId: string;
  dimensions: number;
  hashTables: number;
  randomSeed: number;
  chunkCount: number;
  indexHash: string;
};

export type SparseVectorMetadata = {
  createdAt: string;
  modelId: string;
  vocabularySize: number;
  documentTopTokens: number;
  queryEncoding: "tokenizer-token-weights";
  documentEncoding: "masked-lm-max-log1p-relu";
  chunkCount: number;
  indexHash: string;
};

export type DenseVectorRecord = {
  chunkId: string;
  documentId: string;
  sourceId: string;
  title: string;
  uri: string;
  headingPath: string[];
  text: string;
  embedding: number[];
};

export type SparseVectorRecord = {
  chunkId: string;
  documentId: string;
  sourceId: string;
  title: string;
  uri: string;
  headingPath: string[];
  text: string;
  vector: Record<string, number>;
};

export type DenseVectorPayload = {
  metadata: DenseVectorMetadata;
  indexState: object;
  chunks: DenseVectorRecord[];
};

export type SparseVectorPayload = {
  metadata: SparseVectorMetadata;
  indexState: object;
  chunks: SparseVectorRecord[];
  queryTokenWeights: number[];
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
  retrieval: {
    defaultMode: RetrievalMode;
    dense: DenseVectorModelConfig;
    sparse: SparseVectorModelConfig;
  };
  crawler: {
    defaultUserAgent: string;
    obeyRobotsTxt: boolean;
    rateLimitMs: number;
    maxConcurrentRequests: number;
    renderJs: boolean;
    retentionDays: number;
    fetchArticles: boolean;
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
  sourceType: SourceType;
  score: number;
  title: string;
  uri: string;
  snippet: string;
  text?: string;
  publicationDate?: string | null;
  firstSeenAt: string;
  lastSeenAt: string;
  lastChangedAt: string;
  metadata: Record<string, unknown>;
};

export type SearchResponseData = {
  retrievalMode?: RetrievalMode;
  results: SearchResult[];
};

export type RelatedDocumentResult = {
  documentId: string;
  sourceId: string;
  score: number;
  title: string;
  uri: string;
  metadata: Record<string, unknown>;
};

export type RelatedDocumentsResponseData = {
  sourceDocument: {
    documentId: string;
    sourceId: string;
    title: string;
    uri: string;
  };
  retrievalMode: "dense";
  results: RelatedDocumentResult[];
};

export type ContextSource = {
  chunkId: string;
  documentId: string;
  sourceId: string;
  title: string;
  uri: string;
  text: string;
  metadata: Record<string, unknown>;
};

export type ContextResponseData = {
  retrievalMode?: RetrievalMode;
  markdown: string;
  sources: ContextSource[];
};

export type ModelPullResponse = {
  dense?: { pulled: boolean; modelId: string; cacheDir: string };
  sparse?: { pulled: boolean; modelId: string; cacheDir: string };
};

export type ModelStatusResponse = {
  dense: {
    configured: boolean;
    modelId: string;
    cacheDir: string;
    available: boolean;
    artifactExists: boolean;
  };
  sparse: {
    configured: boolean;
    modelId: string;
    cacheDir: string;
    uvAvailable: boolean;
    available: boolean;
    artifactExists: boolean;
  };
};

export type RunRecord = {
  id: string;
  kind: string;
  createdAt: string;
  success: boolean;
  summary: Record<string, unknown>;
  failures?: Array<{
    sourceId: string;
    uri: string;
    message: string;
  }>;
  documentsSnapshot?: Array<{
    id: string;
    title: string;
    uri: string;
    contentHash: string;
    lastChangedAt: string;
    sourceId: string;
  }>;
};
