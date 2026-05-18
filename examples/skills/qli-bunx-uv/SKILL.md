---
name: qli-bunx-uv
description: Use Querylight CLI from Bun and Python automation without installing a global qli binary.
---

# qli with bunx and uv

Use this skill when you need to run `qli` from a temporary Node toolchain and call it from Python automation.

## When to use this

- You are in a repository that does not have `qli` installed globally.
- You want copyable commands that work with `bunx`.
- You want Python code to call `qli` and parse `--json` output.

## Runtime assumptions

- `bun` is installed and `bunx` is available.
- `uv` is installed for Python environment and script execution.
- The current directory is the workspace you want `qli` to manage, unless you pass `--workspace`.

## Command form

Use `bunx @tryformation/querylight-cli` when the `qli` binary is not already available on `PATH`.

Examples:

```bash
bunx @tryformation/querylight-cli --help
bunx @tryformation/querylight-cli init
bunx @tryformation/querylight-cli source add directory ./docs --name "Local Docs" --tag docs
bunx @tryformation/querylight-cli rebuild
bunx @tryformation/querylight-cli search "api authentication"
```

Use `--json` for scripts, agents, and Python callers:

```bash
bunx @tryformation/querylight-cli search "api authentication" --top-k 8 --json
bunx @tryformation/querylight-cli context "How do API keys work?" --top-k 8 --json
```

## Python with uv

Create a Python virtual environment:

```bash
uv venv
```

Run an inline Python script:

```bash
uv run python - <<'PY'
import json
import subprocess

cmd = [
    "bunx",
    "@tryformation/querylight-cli",
    "search",
    "api authentication",
    "--top-k",
    "5",
    "--json",
]

result = subprocess.run(cmd, check=True, capture_output=True, text=True)
payload = json.loads(result.stdout)
print(json.dumps(payload, indent=2))
PY
```

Run `qli` against an explicit workspace from Python:

```bash
uv run python - <<'PY'
import json
import subprocess

workspace = "/absolute/path/to/project/.kb"
cmd = [
    "bunx",
    "@tryformation/querylight-cli",
    "--workspace",
    workspace,
    "context",
    "Summarize the authentication flow",
    "--top-k",
    "8",
    "--json",
]

result = subprocess.run(cmd, check=True, capture_output=True, text=True)
payload = json.loads(result.stdout)
print(payload["ok"])
PY
```

## Recommended workflow

1. Initialize the workspace once.
2. Add one or more sources.
3. Rebuild after source changes.
4. Use `search`, `related`, or `context` with `--json` from Python automation.

Example:

```bash
bunx @tryformation/querylight-cli init
bunx @tryformation/querylight-cli source add directory ./docs --name "Local Docs" --tag docs
bunx @tryformation/querylight-cli rebuild
uv run python - <<'PY'
import json
import subprocess

cmd = [
    "bunx",
    "@tryformation/querylight-cli",
    "context",
    "How do API keys work?",
    "--top-k",
    "8",
    "--json",
]

result = subprocess.run(cmd, check=True, capture_output=True, text=True)
payload = json.loads(result.stdout)
print(json.dumps(payload, indent=2))
PY
```

## Notes

- `qli` defaults to the `.kb` workspace in the current directory.
- Pass `--workspace` when the Python process runs outside the knowledge base root.
- `search`, `related`, and `context` are the common commands for agent and script integration.
- Run `rebuild` before querying if the workspace has not been indexed yet.
