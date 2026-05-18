# Querylight CLI

`Querylight CLI` is a TypeScript command line application for building and querying local knowledge bases with Querylight TS.

- Package: `@formation/querylight-cli`
- Binary: `qli`
- Runtime: Node.js 22+

It is designed for local, inspectable workflows:

- ingest files, directories, URLs, and websites
- normalize content into Markdown-like text
- chunk documents for retrieval
- build a portable local Querylight index
- search and generate retrieval context for external agents and tools
- inspect workspace state, diffs, and change reports

## Install

Run without installing globally:

```bash
bunx @formation/querylight-cli init
```

Install as a dependency:

```bash
npm install @formation/querylight-cli
```

Then run:

```bash
npx qli --help
```

## Quick Start

Initialize a workspace:

```bash
qli init
```

Add a local docs directory:

```bash
qli source add directory ./docs --name "Local Docs" --tag docs
```

Build the knowledge base:

```bash
qli rebuild
```

Search it:

```bash
qli search "API authentication"
```

Generate retrieval context:

```bash
qli context "How do I authenticate API requests?" --top-k 8
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
    latest.json
    latest.meta.json
  runs/
  logs/
```

Use a custom workspace with:

```bash
qli --workspace ./my-kb <command>
```

## Supported Sources

Current source types:

- `file`
- `directory`
- `url`
- `website`
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
--verbose
--quiet
```

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
qli source add url https://example.com/docs/auth --name "Auth Page"
qli source add website https://example.com --name "Example Site" --max-depth 2 --max-pages 50
```

List and manage them:

```bash
qli source list
qli source disable <source-id>
qli source enable <source-id>
qli source remove <source-id>
```

### Ingest, Chunk, Index

```bash
qli ingest
qli chunk
qli index build
```

Run the full pipeline:

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
qli search "authentication" --json
```

Build retrieval context:

```bash
qli context "How do I configure the API?"
qli context "What changed in pricing?" --top-k 12 --max-chars 12000
```

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
