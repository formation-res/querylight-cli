# Querylight CLI

[![CI](https://github.com/formation-res/querylight-cli/actions/workflows/ci.yml/badge.svg)](https://github.com/formation-res/querylight-cli/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/%40tryformation%2Fquerylight-cli?label=npm)](https://www.npmjs.com/package/@tryformation/querylight-cli)

`Querylight CLI` is a TypeScript command line application for building and querying local knowledge bases with Querylight TS.

- Package: `@tryformation/querylight-cli`
- Binary: `qli`
- Runtime: Node.js 22+

It is designed for local, inspectable workflows:

- ingest files, directories, URLs, and websites
- normalize content into Markdown-like text
- chunk documents for retrieval
- build a portable local Querylight index
- search and generate retrieval context for external agents and tools
- serve an OpenSearch-like `_search` API over one or more local knowledge bases
- inspect workspace state, diffs, and change reports

## Install

Run without installing globally:

```bash
bunx --bun @tryformation/querylight-cli init
```

For agent and Python automation examples that use `bunx` and `uv`, see [`examples/skills/qli-bunx-uv/SKILL.md`](https://github.com/formation-res/querylight-cli/blob/main/examples/skills/qli-bunx-uv/SKILL.md).

Install as a dependency:

```bash
npm install @tryformation/querylight-cli
```

Then run:

```bash
npx qli --help
```

If you prefer to avoid a local install, use:

```bash
bunx --bun @tryformation/querylight-cli --help
```

Use `bunx --bun` for repeated or concurrent `bunx` calls. `bunx` respects the CLI shebang by default and otherwise starts `qli` through `node`.

## Release

Publish releases from semantic version tags such as `0.1.1`.

The GitHub Actions publish workflow publishes `@tryformation/querylight-cli` to the public npm registry.

The publish workflow builds the package and verifies that the built CLI JSON envelope reports the same version as `package.json` before it publishes.

Configure npm trusted publishing for this repository before the first release. The publish workflow uses GitHub OIDC and does not use an `NPM_TOKEN` secret.

### Local Development with `npm link`

If you are working from a local checkout of this repository and want a real `qli` command available in any directory:

```bash
cd /path/to/querylight-cli
npm install
npm run build
npm link
```

After that, you can use `qli` anywhere on your machine:

```bash
cd /some/project
qli --help
```

To remove the linked command later:

```bash
npm unlink -g @tryformation/querylight-cli
```

## Quick Start

Initialize a workspace:

```bash
qli init
```

`qli init` creates the workspace config, enables dense and sparse retrieval for new workspaces, and pulls missing model assets when the runtime is available.

Add a local docs directory:

```bash
qli source add directory ./docs --name "Local Docs" --tag docs
```

Build the knowledge base:

```bash
qli ingest
```

Search it:

```bash
qli search "API authentication"
qli search --source-type rss --since 2026-05-01 --has-publication-date
qli search-json '{"query":{"match":{"text":"API authentication"}},"size":5}'
curl -X POST http://127.0.0.1:3000/_search \
  -H 'content-type: application/json' \
  -d '{"query":{"match":{"text":"API authentication"}},"size":5}'
```

Find related documents for an existing one:

```bash
qli related <document-id-or-uri>
```

Generate retrieval context:

```bash
qli context "How do I authenticate API requests?" --top-k 8
```

Serve the lexical index over HTTP:

```bash
qli serve
```

`qli serve` loads the current workspace index once at startup and reuses it for each request.
Use `POST /_search` or `POST /<configured-index-name>/_search` for a single workspace.
Use `POST /<directory-name>/_search` when `--workspace` points to a directory whose children each contain their own `.kb` workspace.

## Example Skill: `qli` with `bunx` and `uv`

The repository includes an example skill for running `qli` without a global install and calling it from Python with `uv`:

- [`examples/skills/qli-bunx-uv/SKILL.md`](https://github.com/formation-res/querylight-cli/blob/main/examples/skills/qli-bunx-uv/SKILL.md)

It covers:

- running `qli` with `bunx --bun @tryformation/querylight-cli`
- using `--json` for automation and agents
- calling `qli search` and `qli context` from Python with `subprocess`

## Example: Index `querylight.tryformation.com`

This example uses a local linked build of `qli` to create a test knowledge base for the Querylight documentation website.

1. Link the local CLI:

```bash
cd /path/to/querylight-cli
npm install
npm run build
npm link
```

2. Create a fresh test workspace:

```bash
mkdir -p ~/querylight-ts-search
cd ~/querylight-ts-search
```

3. Initialize the knowledge base:

```bash
qli init
```

4. Add the Querylight website as a source:

```bash
qli source add website https://querylight.tryformation.com \
  --name "Querylight TS Docs" \
  --max-depth 2 \
  --max-pages 50 \
  --include /docs/ \
  --tag docs
```

`qli source add website` may also detect one blog or news feed and register it as a separate `rss` source. Use `--json` when another tool needs the full list of created sources.
Use `qli source add page` for one page. Use `qli source add website` when you want crawling or feed detection.

5. Ingest content and refresh the local index:

```bash
qli ingest
```

6. Inspect and query the result:

```bash
qli status
qli source list
qli search "BM25 ranking"
qli context "How does Querylight TS handle BM25 ranking?" --top-k 8
```

If you want the workspace somewhere else, use:

```bash
qli --workspace /custom/path/.kb <command>
```

## Workspace

The default workspace is `.kb/`.

```text
.kb/
  config.yaml
  sources/
    sources.jsonl
  documents/
    documents.jsonl
  chunks/
    chunks.jsonl
  raw/
  normalized/
  indexes/
    latest.json.gz
    latest.meta.json.gz
  runs/
  logs/
```

Vector model downloads are shared across workspaces under `~/.qli/models/` by default. `qli init` pulls missing model assets for enabled retrieval modes, so a new workspace is ready for vector indexing after setup.

Use a custom workspace with:

```bash
qli --workspace ./my-kb <command>
```

Control the default remote concurrency in `config.yaml`:

```yaml
crawler:
  maxConcurrentRequests: 5
```

Set `crawl.maxConcurrentRequests` on a website or RSS source when one source needs a different limit.

Control the default number of search results returned when `--top-k` is omitted:

```yaml
search:
  defaultTopK: 50
```

For `qli search --source-type rss` with a time-window filter such as `--since`, `--until`, or `--publication-date-from`, `qli` uses `500` results when `--top-k` is omitted.

## Supported Sources

Current source types:

- `file`
- `directory`
- `page`
- `website`
- `rss`
- `markdown`
- `text`

Current local file ingestion support:

- `.md`
- `.txt`
- `.html`
- `.htm`
- `.pdf`
- `.docx`

## Commands

All commands support:

```bash
--workspace <path>
--config <path>
--json
--silent
--verbose
```

Long-running commands print progress to stderr by default. Use `--silent` to suppress progress output. Use `--json` when another tool needs stable structured output.

### Initialize

```bash
qli init
qli init --workspace ./kb
qli init --force
```

### Manage Sources

Add sources:

```bash
qli source add file ./docs/guide.md --name "Guide"
qli source add directory ./docs --name "Docs" --tag docs
qli source add page https://example.com/docs/auth --name "Auth Page"
qli source add website https://example.com --name "Example Site" --max-depth 2 --max-pages 50
qli source add website https://example.com --name "Example Site" --max-concurrent-requests 8
qli source add website https://example.com --name "Example Site" --json
qli source add rss https://example.com/feed.xml --name "Release Feed"
qli source add rss https://example.com/feed.xml --name "Release Feed" --max-concurrent-requests 3
```

`page` stores one page. `website` crawls a site and may detect one feed during registration.

Website sources may detect one blog or news feed during registration. When qli can infer a shared article prefix such as `/blog/` or `/news/`, it adds that prefix to the website source excludes to reduce duplicate ingestion.
Website and RSS sources default to `5` remote requests in flight per source. Override that in `config.yaml` or on the source.

List and manage them:

```bash
qli source list
qli source config <source-id> --retention-days 30
qli source config <source-id> --max-concurrent-requests 2
qli source config <source-id> --name "Docs Feed" --tag rss docs
qli source disable <source-id>
qli source enable <source-id>
qli source remove <source-id>
```

### Find Related Documents

Build dense vectors first:

```bash
qli models pull --dense
qli rebuild
```

Or pull every model that is available on the current machine:

```bash
qli models pull
```

By default, `qli models pull` stores model assets in `~/.qli/models/` so multiple workspaces can reuse them.

Then ask for documents related to an existing document id or URI:

```bash
qli related <document-id>
qli related https://example.com/docs/auth
```

### Ingest, Chunk, Index

```bash
qli ingest
qli chunk
qli index build
qli rebuild --silent
```

`qli ingest` fetches source content, updates affected chunks, and refreshes the index.
Remote website and RSS fetches run concurrently. By default qli allows `5` in-flight requests per source.

Use `qli rebuild` when you want the explicit full pipeline command:

```bash
qli rebuild
qli rebuild --source <source-id>
qli rebuild --changed-only
```

### Search and Retrieval

Search:

```bash
qli search "pricing API limits"
qli search "refund policy" --tag support --top-k 20
qli search --source-type rss,page --since 2026-05-01 --has-publication-date --top-k 25
qli search --source-name "Release Feed,Company Blog" --uri-prefix https://example.com/news,https://example.com/blog
qli search --source-type rss,page --top-k 25 --json
qli search "authentication" --json
qli search-json '{"query":{"bool":{"filter":[{"term":{"sourceType":"rss"}}]}},"size":10}' --json
```

Build retrieval context:

```bash
qli context "How do I configure the API?"
qli context "What changed in pricing?" --top-k 12 --max-chars 12000
```

Serve the lexical index over HTTP:

```bash
qli serve
qli serve --workspace ./docs/.kb --port 4000
qli serve --workspace ./kbs --host 0.0.0.0 --port 4000
```

For a single workspace, use `POST /_search` or `POST /<configured-index-name>/_search`.
For a directory of knowledge bases, use `POST /<directory-name>/_search`.
The request body must be a Querylight JSON DSL object.

### Change Inspection

```bash
qli diff
qli diff --source <source-id>
qli diff --document <document-id>
qli diff --since 2026-05-01
```

```bash
qli report changes --since 2026-05-01
qli report changes --source <source-id>
```

### Workspace Inspection

```bash
qli status
qli doctor
```

## JSON Output

Agent-facing and automation-friendly commands support `--json`.

The output envelope is:

```json
{
  "ok": true,
  "command": "search",
  "workspace": "/absolute/path/.kb",
  "version": "0.1.0",
  "data": {}
}
```

## Docker

Build the image:

```bash
docker build -t querylight-cli .
```

Run commands against a mounted workspace:

```bash
docker run --rm -v "$PWD:/data" querylight-cli init --workspace /data/.kb
docker run --rm -v "$PWD:/data" querylight-cli rebuild --workspace /data/.kb
docker run --rm -v "$PWD:/data" querylight-cli search --workspace /data/.kb "authentication"
```

## Development

Install dependencies:

```bash
npm install
```

Run checks:

```bash
npm run check
```

Build:

```bash
npm run build
```
