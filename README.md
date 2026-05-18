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
npm unlink -g @formation/querylight-cli
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

Find related documents for an existing one:

```bash
qli related <document-id-or-uri>
```

Generate retrieval context:

```bash
qli context "How do I authenticate API requests?" --top-k 8
```

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

5. Build the local index:

```bash
qli rebuild
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
