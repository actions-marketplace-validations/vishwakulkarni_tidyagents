# AGENTS.md

Instructions for AI coding agents working on tidyagents.

## Project
- A zero-dependency Node.js CLI that lints AI agent instruction files.
- Rules and scoring live in `src/lint.js`; commands and output live in `src/cli.js`.
- `vscode/` is the VS Code extension and `orca/` with `orca-plugin.json` is the Orca plugin. Both are thin adapters over `src/lint.js`; put rule changes there, not in them.
- One `vX.Y.Z` tag releases the CLI, the extension and the Orca plugin, so bump all three versions together.

## Commands
- Test: `npm test`
- Try it on this repo: `node bin/tidyagents.js`
- Test the VS Code extension: `cd vscode && npm install && npm test` (downloads VS Code once).
- Test the Orca plugin: `orca plugin test . --json` (needs Orca installed).

## Conventions
- Never add a runtime dependency. Use Node built-ins only.
- Prefer missing a finding over a false positive. Add a regression test for every false positive you fix in `test/lint.test.js`.
- `fix` may only delete lines it is sure about. Anything uncertain is reported, not removed.
