# tidyagents for VS Code, Cursor, Antigravity and Windsurf

Lint and score your AI agent instruction files as you edit: `AGENTS.md`, `CLAUDE.md`, `GEMINI.md`, `SKILL.md`, `.cursorrules`, `.github/copilot-instructions.md`, and the rule folders of Claude Code, Cursor, Copilot, Cline, Windsurf, Antigravity, Kiro and Roo Code.

Agent files rot quietly. Code moves and files get renamed, and the instructions your agent reads every session keep pointing at things that no longer exist. This extension flags that as it happens.

## What you get

- **Problems in the editor**: stale paths, missing `npm run` scripts, broken `@imports` and links, contradictions, duplicates, vague rules, oversized files and skill frontmatter errors, each on its line.
- **Score in the status bar**: the lowest score of any agent file in the workspace. It turns yellow below 80. Click it to open the Problems panel.
- **Quick fixes**: remove a duplicate rule, a dead script line or extra blank lines. The fix only deletes lines it is sure about.
- **Rechecks on rename**: creating, deleting or renaming any file re-checks every agent file, because that is how paths go stale. Edits made outside the editor, such as by an agent in a terminal, count too.

Everything runs locally: no network calls, no telemetry and no AI calls. The extension uses the same zero-dependency linter as the [`tidyagents` CLI](https://github.com/vishwakulkarni/tidyagents), so your editor, CI and pre-commit hook give the same score.

## Commands

- **tidyagents: Check agent files** re-checks the whole workspace.
- **tidyagents: Apply safe fixes to this file** applies every safe fix in the active file.

To silence a finding, put `<!-- tidyagents-disable-next-line rule -->` above it, or `<!-- tidyagents-disable-file rule -->` anywhere in the file. See the [rule list](https://github.com/vishwakulkarni/tidyagents#what-it-checks).
