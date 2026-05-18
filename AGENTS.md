# AGENTS.md

This repository ships a CLI that is often consumed by other tools and agents, not only by humans in a terminal. Keep the built-in help and the written documentation explicit enough that another tool can infer the correct workflow without reading the source.

## Documentation rules

- Use the `copy-tone` guidance for all user-facing documentation.
- Keep wording factual, direct, and operational.
- Do not use hype, marketing phrasing, or rhetorical contrast patterns.
- Prefer short statements that describe what a command does, when to use it, and what it returns.
- Prefer examples that can be copied as-is.

## Help text consistency

- Treat `qli --help` and `qli <command> --help` as the primary documentation surface.
- When adding or changing a command, update:
  - the top-level command description if the workflow changed
  - the command description
  - option help text for any new flags
  - the command-specific examples in `addHelpText`
- Keep examples realistic and minimal. Show the common path first.
- If a command is meant for automation or agents, mention `--json` where that matters.
- If a command depends on prior setup, state that directly in the help text.

## README consistency

- Keep README examples aligned with the built-in help.
- If you change command behavior, check whether the quick start, workflow examples, and option usage in `README.md` also need updates.
- Do not let README examples drift from what the CLI actually accepts.

## Verification

- Run the relevant help output after editing CLI help text.
- Prefer adding or updating tests when the help structure or wording is important to preserve.
- At minimum, verify:
  - `qli --help`
  - `qli source add --help`
  - one query command such as `qli search --help`
