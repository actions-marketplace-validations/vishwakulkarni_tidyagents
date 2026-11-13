<p align="center"><img src="docs/logo/logo.svg" alt="tidyagents logo: a robot sweeping with a broom" width="420"></p>

# tidyagents

[![npm](https://img.shields.io/npm/v/tidyagents)](https://www.npmjs.com/package/tidyagents)
[![License: Apache 2.0](https://img.shields.io/badge/license-Apache%202.0-blue)](LICENSE)
![Dependencies: 0](https://img.shields.io/badge/dependencies-0-brightgreen)
![Node >=18.3](https://img.shields.io/badge/node-%3E%3D18.3-blue)

Lint, score and tidy your AI agent instruction files: `AGENTS.md`, `CLAUDE.md`, `GEMINI.md`, `SKILL.md`, `.cursorrules`, `.github/copilot-instructions.md`, and the rule folders of Claude Code, Cursor, Copilot, Cline and Windsurf.

Agent files grow quietly. Code moves, files get renamed, and the instructions your agent reads every session keep pointing at things that no longer exist. `tidyagents` finds the rot and cleans up what's safe to clean.

<p align="center"><img src="docs/demo.gif" alt="tidyagents scores a CLAUDE.md at 71, then fix removes a dead script, a blank line and a duplicate to reach 86" width="768"></p>

```bash
npx tidyagents
```

## The numbers

We ran `tidyagents` on **67 popular open-source repos** (300+ stars, actively maintained, 418 agent files, ~851k tokens of agent instructions).

<p align="center"><img src="docs/findings.svg" alt="Of 67 repos: 63% have an oversized agent file, 27% have stale paths, 28% are clean" width="768"></p>

- **27% (18 repos) send their agent to files that no longer exist**: 97 stale paths in total.
- **63% (42 repos) have at least one oversized file.** Even Anthropic's own `claude-api` skill is 26,280 tokens.

### Bloat costs you on every session

Always-loaded files (`AGENTS.md`, `CLAUDE.md`, `GEMINI.md`, `.cursorrules`) are read before the agent does any work. A quarter of them are over budget; the largest is 15,125 tokens. The median is 929.

<p align="center"><img src="docs/token-sizes.svg" alt="Histogram of 188 always-loaded files: 139 under 2,000 tokens, 49 over" width="768"></p>

### Before and after

Real fixes found by `tidyagents` in public repos and sent upstream:

<p align="center"><img src="docs/before-after.svg" alt="Scores before and after: mongoose-unique-validator 50 to 100, swarm-tools 60 to 80, vuepress-theme-plume 86 to 96" width="768"></p>

| Repo | File | What was stale | Score | Fix |
|---|---|---|---|---|
| mongoose-unique-validator (543★) | `CLAUDE.md` | Whole test layout: tests moved from `.js` files to `.ts` and new folders | **50 → 100** | [PR #169](https://github.com/mongoose-unique-validator/mongoose-unique-validator/pull/169) |
| joelhooks/swarm-tools (749★) | `AGENTS.md` | Skills folder renamed `.opencode/skills/` → `.opencode/skill/` | **60 → 80** | [PR #212](https://github.com/joelhooks/swarm-tools/pull/212) (auto-closed: repo takes vouched contributors only) |
| vuepress-theme-plume (497★) | `AGENTS.md` | `ConfigLoader.ts` moved into `features/` | **86 → 96** | [PR #1080](https://github.com/pengzhanbo/vuepress-theme-plume/pull/1080) |

### Big-name repos

| Repo | Agent files | Score | Top finding |
|---|---|---|---|
| anthropics/skills | 20 | 90 | `claude-api` skill is 26,280 tokens |
| vercel/ai | 18 | 90 | root `AGENTS.md` is 4,054 tokens, loaded every session |
| anthropics/claude-cookbooks | 7 | 96 | `skills/CLAUDE.md` is 2,094 tokens |
| google-gemini/gemini-cli | 12 | 96 | `skill-creator` skill is 5,023 tokens |
| google/adk-python | 11 | 100 | clean |
| openai/codex | 8 | 100 | clean |

Scanned November 2026 with tidyagents 0.1.0. Every finding in these tables was checked by hand. Full write-up: [27% of popular repos send their AI agent to files that don't exist](docs/state-of-agent-files-2026.md).

## Quick start

```bash
npx tidyagents
```

```
$ npx tidyagents

CLAUDE.md  57/100  (70 tokens)
  ✗ line 6   references `scripts/deploy.sh`, which does not exist  [missing-path]
  ✗ line 7   runs script "typecheck", which is not in package.json  [missing-script]
  · line 9   3 blank lines in a row  [blank-lines] fixable
  ⚠ line 11  "follow best practices" is too vague for an agent to act on  [vague]
  ✗ line 12  contradicts line 4; keep one of them  [contradiction]
  ⚠ line 13  repeats line 5  [duplicate] fixable

Score: 57/100  ·  2 fixable, run tidyagents fix
```

## Why tidyagents

- **Zero dependencies, no AI calls, works offline.** One command.
- **Built to stay quiet when unsure.** It skips gitignored build output, files the instructions say to create, examples like `e.g. src/foo/`, and skills (which describe other people's projects). Tuned against 67 real repos to cut false positives.
- **Safe to run.** `fix` shows a diff and asks before it writes, and never deletes a line it isn't sure about.
- **Fits in CI.** `--min-score` fails the build when agent files rot.

## For teams and companies

Every engineer's agent reads the same instruction files at the start of every session. When those files rot, the cost multiplies across the team: wrong paths send agents on wasted searches, and bloat is paid for on every run. For example, a 4,000-token `CLAUDE.md` read by 50 engineers in 10 sessions a day is 2 million input tokens a day before any work starts.

- **Safe to adopt.** Apache 2.0, with an explicit patent grant. Free for commercial use, with no copyleft.
- **Nothing to audit but ~730 lines.** No dependencies means no supply-chain risk and nothing for security review to chase.
- **Your instructions never leave the machine.** No network calls, no telemetry, no model calls. It reads files and runs `git check-ignore`, nothing else.
- **Deterministic.** The same files always get the same score, so it is a stable CI gate.
- **Monorepo aware.** Scripts are checked against every `package.json` in the repo.
- **Works across agents.** One check for Claude Code, Codex, Gemini CLI, Cursor and GitHub Copilot files.
- **Reports in JSON.** Feed `--json` into a dashboard to track agent-file health across every repo in your org.

### Roll it out

1. Run `npx tidyagents` in your largest repo and fix what it finds.
2. Add the [GitHub Action](#use-in-ci) with `min-score: 80` so new rot fails the pull request.
3. Track it across repos with `--json`:

```bash
for repo in */; do
  (cd "$repo" && npx -y tidyagents --json | jq -c --arg r "$repo" '{repo: $r, score}')
done
```

## Commands

```bash
tidyagents              # score every agent file and list issues
tidyagents fix          # show a diff of safe fixes, ask, then apply
tidyagents badge        # print a README badge for your score
tidyagents init         # create a starter AGENTS.md
```

You can pass specific files, e.g. `npx tidyagents CLAUDE.md`. With no files, it searches the current folder (skipping `node_modules`, template and fixture folders such as `templates/` and `fixtures/`, and hidden folders other than `.claude`, `.cursor`, `.agents`, `.codex` and `.gemini`) for:

- `AGENTS.md`, `AGENTS.override.md`, `CLAUDE.md`, `CLAUDE.local.md`, `GEMINI.md` and `SKILL.md` in any folder
- `.cursorrules`, `.windsurfrules`, `.clinerules` and `.github/copilot-instructions.md` at the root
- Rule folders at the root: `.claude/rules/**/*.md`, `.cursor/rules/**/*.mdc`, `.github/instructions/**/*.instructions.md`, `.clinerules/*.md` and `.windsurf/rules/*.md`

| Option | |
|---|---|
| `--min-score <n>` | Exit with code 1 if the score is below `n` |
| `--json` | Print check results as JSON |
| `--format github` | Also print GitHub Actions annotations, so issues show inline on the PR |
| `-y, --yes` | Apply fixes without the prompt |

## What it checks

| Rule | Severity | Auto-fix |
|---|---|---|
| `missing-path`: a backticked path like `src/old.js` whose top folder exists but the file is gone. Gitignored paths, paths inside git submodules, lines about creating files or giving examples, and `SKILL.md` files are skipped. When exactly one tracked file has the same name, the message says where it moved | error | no, it may be a file the agent should create |
| `missing-path` (links): a relative markdown link like `[guide](docs/guide.md)` to a file that is gone. Checked in `SKILL.md` too, against the skill's own folder | error | no |
| `missing-import`: a Claude Code `@path/to/file.md` import that points nowhere, so nothing is loaded. Mentions like `@alice`, package scopes and `@~/` home paths are skipped | error | no |
| `missing-script`: `npm run x` / `pnpm run x` where no `package.json` in the repo defines `x` | error | removes the bullet if nothing else in it works |
| `contradiction`: "always X" and "never X" in the same file | error | no, you pick |
| `duplicate`: the same top-level bullet twice in one section, ignoring case and punctuation | warn | removes the repeat |
| `vague`: short rules like "write clean code" an agent can't act on | warn | no |
| `size`: over 2,000 tokens (warn) or 4,000 (error), counting files pulled in with `@imports`. `SKILL.md` files and scoped rules (`paths`, `globs`, `applyTo`) load only when used, so 5,000 / 10,000 | warn/error | no |
| `skill-frontmatter`: a `SKILL.md` with no `description`, unclosed frontmatter, a `name` outside the [Agent Skills spec](https://agentskills.io/specification) (lowercase, digits, hyphens, ≤64), or a description longer than the spec's 1,024 or Claude Code's 1,536-character listing | warn/error | no |
| `shadowed`: an `AGENTS.md` next to a `CLAUDE.md` that never mentions it. Claude Code then reads only `CLAUDE.md`, so add `@AGENTS.md` to it | warn | no |
| `no-agents-md`: a `.cursorrules` with no `AGENTS.md` at the repo root, so only Cursor gets those rules | info | no |
| `blank-lines`: runs of blank lines | info | collapses them |

Content inside code fences and YAML frontmatter is ignored, and table rows are ignored for duplicates and contradictions.

**Turning a rule off:** put an HTML comment above the line, or anywhere in the file for the whole file. List rules to silence only those; with none, all are silenced. Claude Code strips these comments before loading the file, so they cost no tokens.

```markdown
<!-- tidyagents-disable-next-line missing-path -->
- Write the report to `reports/summary.md`

<!-- tidyagents-disable-file vague, size -->
```

**Scoring:** each file starts at 100 and loses 10 per error, 4 per warning and 1 per info. The repo score is the lowest file score.

**Fix safety:** `fix` only deletes lines, always shows them first, and never writes without `--yes` or a `y` at the prompt. If it's unsure, it flags instead of deleting.

## Use in CI

With the GitHub Action:

```yaml
# .github/workflows/agent-files.yml
name: agent files
on: [pull_request]
jobs:
  tidyagents:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v5
      - uses: vishwakulkarni/tidyagents@v1
        with:
          min-score: 80              # default 80
          # working-directory: .     # folder to check
```

The action runs on the runner's own Node with no install step, and issues show up as inline annotations on the PR's changed files. On any other CI, run `npx -y tidyagents --min-score 80`.

## Use as a pre-commit hook

Renaming a file is the usual way an agent file goes stale, so the hook runs on every commit, not only when an agent file changes. A run takes well under a second.

With the [pre-commit](https://pre-commit.com) framework (v0.4.0 and later):

```yaml
# .pre-commit-config.yaml
repos:
  - repo: https://github.com/vishwakulkarni/tidyagents
    rev: v0.4.0
    hooks:
      - id: tidyagents
        # args: [--min-score, "90"]   # default 80
```

Or as a plain git hook, with no extra tools:

```bash
printf '#!/bin/sh\nexec npx -y tidyagents --min-score 80\n' > .git/hooks/pre-commit
chmod +x .git/hooks/pre-commit
```

## Use in your editor

The same linter runs as you work. No setup is needed, and nothing leaves your machine.

**VS Code, Cursor, Antigravity and Windsurf:** install **tidyagents** from the Extensions view: the [Visual Studio Marketplace](https://marketplace.visualstudio.com/items?itemName=vishwakulkarni.tidyagents) for VS Code, and [Open VSX](https://open-vsx.org/extension/vishwakulkarni/tidyagents) for the others. Issues show up in the Problems panel, the score sits in the status bar, and quick fixes remove duplicates and dead lines. Creating, deleting or renaming any file re-checks the agent files, so you see a stale path as soon as you cause one. See [`vscode/`](vscode/README.md).

**[Orca](https://github.com/stablyai/orca)** (v0.4.0 and later):

```bash
orca plugin install vishwakulkarni/tidyagents
```

The status bar shows the score of the focused workspace's agent files. When an agent finishes and leaves them below 80, you get a notification. The **tidyagents: Check agent files** command lists the issues. Orca asks you to approve what the plugin can access: reading your workspaces and agent status, and showing notifications.

## Badge

```bash
tidyagents badge
```

Prints markdown like `![tidyagents](https://img.shields.io/badge/tidyagents-92%2F100-brightgreen)`. The badge is static, so re-run it after you improve your score.

## License

[Apache License 2.0](LICENSE). Copyright 2026 Vishwanath Kulkarni.
