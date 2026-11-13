import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { createInterface } from 'node:readline/promises';
import {
  lintRepo, lintOptions, lintText, applyFixes, overallScore, badgeMarkdown, readScripts,
} from './lint.js';

const COMMANDS = new Set(['check', 'fix', 'badge', 'init']);

const HELP = `tidyagents: lint and tidy AI agent instruction files

Usage
  tidyagents [check] [files...]   Score files and list issues (default)
  tidyagents fix [files...]       Show a diff of safe fixes, then apply them
  tidyagents badge                Print README badge markdown for your score
  tidyagents init                 Create a starter AGENTS.md

Options
  --min-score <n>   Exit with code 1 if the score is below n (for CI)
  --json            Print check results as JSON
  --format <name>   text (default), json, or github (inline PR annotations)
  -y, --yes         Apply fixes without asking
  -h, --help        Show this help
  -v, --version     Show version

With no files given, it finds AGENTS.md, CLAUDE.md, GEMINI.md, SKILL.md,
.cursorrules, .github/copilot-instructions.md and the rule folders of
Claude Code, Cursor, Copilot, Cline, Windsurf, Antigravity, Kiro and Roo
Code in the current folder.

Silence a finding with <!-- tidyagents-disable-next-line rule --> above it,
or <!-- tidyagents-disable-file rule --> anywhere in the file.`;

const useColor = process.stdout.isTTY && !process.env.NO_COLOR;
const paint = (code) => (s) => (useColor ? `\x1b[${code}m${s}\x1b[0m` : s);
const red = paint(31), yellow = paint(33), green = paint(32), dim = paint(2), bold = paint(1);

const ICON = { error: red('✗'), warn: yellow('⚠'), info: dim('·') };
const scoreColor = (score) => (score >= 90 ? green : score >= 70 ? yellow : red);

function lintTargets(paths, root) {
  for (const file of paths) {
    if (!existsSync(file)) throw new UsageError(`File not found: ${file}`);
  }
  return lintRepo(root, paths.length ? paths : null).results;
}

class UsageError extends Error {}

function printResults(results) {
  for (const r of results) {
    console.log(`\n${bold(r.file)}  ${scoreColor(r.score)(`${r.score}/100`)}  ${dim(`(${r.tokens.toLocaleString('en-US')} tokens)`)}`);
    for (const issue of r.issues) {
      const where = issue.line ? `line ${issue.line}` : 'file';
      const fixable = issue.remove ? green(' fixable') : '';
      console.log(`  ${ICON[issue.severity]} ${dim(where.padEnd(8))} ${issue.message}  ${dim(`[${issue.rule}]`)}${fixable}`);
    }
  }
}

// GitHub Actions workflow commands: each line becomes an inline annotation on the PR.
// https://docs.github.com/actions/reference/workflow-commands-for-github-actions
const ANNOTATION = { error: 'error', warn: 'warning', info: 'notice' };
const escapeData = (s) => s.replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
const escapeProperty = (s) => escapeData(s).replace(/:/g, '%3A').replace(/,/g, '%2C');

function printAnnotations(results) {
  // Annotation paths are relative to the repo root, which differs from cwd under working-directory.
  const base = process.env.GITHUB_WORKSPACE || process.cwd();
  for (const r of results) {
    const file = escapeProperty(relative(base, resolve(r.path)).split('\\').join('/'));
    for (const issue of r.issues) {
      const line = issue.line ? `,line=${issue.line}` : '';
      console.log(`::${ANNOTATION[issue.severity]} file=${file}${line},title=${escapeProperty(`tidyagents ${issue.rule}`)}::${escapeData(issue.message)}`);
    }
  }
}

function check(results, opts) {
  const score = overallScore(results);
  if (opts.format === 'github') printAnnotations(results);
  if (opts.format === 'json') {
    const files = results.map(({ file, tokens, score, issues }) => ({
      file, tokens, score,
      issues: issues.map(({ remove, ...issue }) => ({ ...issue, fixable: Boolean(remove) })),
    }));
    console.log(JSON.stringify({ score, files }, null, 2));
  } else {
    printResults(results);
    const fixable = results.reduce((n, r) => n + r.issues.filter((i) => i.remove).length, 0);
    console.log(`\nScore: ${scoreColor(score)(`${score}/100`)}${fixable ? `  ·  ${fixable} fixable, run ${bold('tidyagents fix')}` : ''}`);
  }
  return score;
}

async function confirm(question) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return /^y(es)?$/i.test((await rl.question(question)).trim());
  } finally {
    rl.close();
  }
}

async function fix(results, opts, root) {
  const changes = [];
  for (const r of results) {
    const fixable = r.issues.filter((i) => i.remove);
    if (!fixable.length) continue;
    const fixed = applyFixes(r.text, fixable);
    const after = lintText(fixed, lintOptions(r.path, root));
    changes.push({ r, fixed, after, count: fixable.length });

    console.log(`\n${bold(r.file)}: ${r.score} → ${after.score}  ${dim(`(${r.tokens} → ${after.tokens} tokens)`)}`);
    const lines = r.text.split(/\r?\n/);
    for (const issue of fixable) {
      for (const index of issue.remove) {
        const text = lines[index].trim() || '(blank line)';
        console.log(red(`  - ${String(index + 1).padStart(4)}: ${text}`) + dim(`  [${issue.rule}]`));
      }
    }
  }

  const manual = results.reduce((n, r) => n + r.issues.filter((i) => !i.remove).length, 0);
  const manualNote = manual ? `\n${manual} issue(s) need a human decision; run ${bold('tidyagents')} to see them.` : '';

  if (!changes.length) {
    console.log(`Nothing to fix automatically.${manualNote}`);
    return;
  }

  const total = changes.reduce((n, c) => n + c.count, 0);
  if (!opts.yes) {
    if (!process.stdin.isTTY) {
      console.log(`\nDry run: re-run with ${bold('--yes')} to apply ${total} fix(es).`);
      return;
    }
    if (!(await confirm(`\nApply ${total} fix(es) to ${changes.length} file(s)? [y/N] `))) {
      console.log('No changes made.');
      return;
    }
  }
  for (const { r, fixed } of changes) writeFileSync(r.path, fixed);
  console.log(`${green('✓')} Applied ${total} fix(es).${manualNote}`);
}

function init(root) {
  const target = join(root, 'AGENTS.md');
  if (existsSync(target)) throw new UsageError('AGENTS.md already exists. Run `tidyagents` to check it instead.');

  const scripts = readScripts(root);
  const commandLines = scripts
    ? [
        '- Install: `npm install`',
        ...['test', 'lint', 'build']
          .filter((name) => name in scripts)
          .map((name) => `- ${name[0].toUpperCase()}${name.slice(1)}: \`npm run ${name}\``),
      ]
    : ['- Install:', '- Test:', '- Lint:'];

  writeFileSync(target, `# AGENTS.md

Instructions for AI coding agents working in this repository.

## Project
- What this project is, in one sentence.

## Commands
${commandLines.join('\n')}

## Conventions
- Only rules the code does not already enforce. Skip anything a linter or formatter checks.

## Off limits
- Files or actions an agent must leave alone.
`);
  console.log(`${green('✓')} Created AGENTS.md. Fill in the blanks, then run ${bold('tidyagents')}.`);
}

export async function main(argv) {
  const { values: opts, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      'min-score': { type: 'string' },
      json: { type: 'boolean' },
      format: { type: 'string', default: 'text' },
      yes: { type: 'boolean', short: 'y' },
      help: { type: 'boolean', short: 'h' },
      version: { type: 'boolean', short: 'v' },
    },
  });

  if (opts.help) return console.log(HELP), 0;
  if (opts.version) {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
    return console.log(pkg.version), 0;
  }

  if (opts.json) opts.format = 'json';
  if (!['text', 'json', 'github'].includes(opts.format)) throw new UsageError('--format must be text, json or github');

  const command = COMMANDS.has(positionals[0]) ? positionals.shift() : 'check';
  const minScore = opts['min-score'] === undefined ? null : Number(opts['min-score']);
  if (minScore !== null && !(minScore >= 0 && minScore <= 100)) throw new UsageError('--min-score must be a number from 0 to 100');

  const root = process.cwd();
  if (command === 'init') return init(root), 0;

  const results = lintTargets(positionals, root);
  if (!results.length && !(command === 'check' && opts.format === 'json')) {
    console.log(`No agent instruction files found. Run ${bold('tidyagents init')} to create one.`);
    return command === 'badge' ? 1 : 0;
  }

  if (command === 'badge') return console.log(badgeMarkdown(overallScore(results))), 0;
  if (command === 'fix') return await fix(results, opts, root), 0;

  const score = check(results, opts);
  if (minScore !== null && score < minScore) {
    if (opts.format !== 'json') console.error(red(`\nScore ${score} is below --min-score ${minScore}.`));
    return 1;
  }
  return 0;
}

export async function run(argv) {
  try {
    process.exitCode = await main(argv);
  } catch (error) {
    const expected = error instanceof UsageError || error.code?.startsWith('ERR_PARSE_ARGS');
    console.error(red(expected ? error.message : error.stack));
    if (expected) console.error(`Run ${bold('tidyagents --help')} for usage.`);
    process.exitCode = 2;
  }
}
