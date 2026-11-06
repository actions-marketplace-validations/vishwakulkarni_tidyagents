# AGENTS.md

Instructions for AI coding agents working on tidyagents.

## Project
- A zero-dependency Node.js CLI that lints AI agent instruction files.
- Rules and scoring live in `src/lint.js`; commands and output live in `src/cli.js`.

## Commands
- Test: `npm test`
- Try it on this repo: `node bin/tidyagents.js`

## Conventions
- Never add a runtime dependency. Use Node built-ins only.
- Prefer missing a finding over a false positive. Add a regression test for every false positive you fix in `test/lint.test.js`.
- `fix` may only delete lines it is sure about. Anything uncertain is reported, not removed.
