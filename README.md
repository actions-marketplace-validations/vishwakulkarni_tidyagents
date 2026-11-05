# tidyagents

Lint, score and tidy your AI agent instruction files: `AGENTS.md`, `CLAUDE.md`, `GEMINI.md`, `SKILL.md`, `.cursorrules` and `.github/copilot-instructions.md`.

Agent files grow quietly. Rules get duplicated, scripts get renamed, files get deleted, and every stale line is loaded into every agent session. `tidyagents` finds the rot and cleans up what's safe to clean.

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

Zero dependencies, no AI calls, works offline.

## Commands

```bash
npx tidyagents              # score every agent file and list issues
npx tidyagents fix          # show a diff of safe fixes, ask, then apply
npx tidyagents badge        # print a README badge for your score
npx tidyagents init         # create a starter AGENTS.md
```

You can pass specific files, e.g. `npx tidyagents CLAUDE.md`. With no files, it searches the current folder (skipping `node_modules` and hidden folders other than `.claude`).

| Option | |
|---|---|
| `--min-score <n>` | Exit with code 1 if the score is below `n` |
| `--json` | Print check results as JSON |
| `-y, --yes` | Apply fixes without the prompt |

## What it checks

| Rule | Severity | Auto-fix |
|---|---|---|
| `missing-path`: a backticked path like `src/old.js` whose top folder exists but the file is gone (skipped in `SKILL.md`, which describes other projects) | error | no, it may be a file the agent should create |
| `missing-script`: `npm run x` where `x` isn't in `package.json` | error | removes the bullet if nothing else in it works |
| `contradiction`: "always X" and "never X" in the same file | error | no, you pick |
| `duplicate`: the same bullet twice in one section, ignoring case and punctuation | warn | removes the repeat |
| `vague`: short rules like "write clean code" an agent can't act on | warn | no |
| `size`: over 2,000 tokens (warn) or 4,000 (error); `SKILL.md` files load only when used, so 5,000 / 10,000 | warn/error | no |
| `blank-lines`: runs of blank lines | info | collapses them |

Content inside code fences and table rows is ignored for duplicates and contradictions. The rules are tuned to stay quiet when unsure: on anthropics/skills, gemini-cli, codex, adk-python and vercel/ai they flag only oversized files and one real duplicate.

**Scoring:** each file starts at 100 and loses 10 per error, 4 per warning and 1 per info. The repo score is the lowest file score.

**Fix safety:** `fix` only deletes lines, always shows them first, and never writes without `--yes` or a `y` at the prompt. If it's unsure, it flags instead of deleting.

## Use in CI

```yaml
- run: npx tidyagents --min-score 80
```

## Badge

```bash
npx tidyagents badge
```

Prints markdown like `![tidyagents](https://img.shields.io/badge/tidyagents-92%2F100-brightgreen)`. The badge is static, so re-run it after you improve your score.

## License

MIT
