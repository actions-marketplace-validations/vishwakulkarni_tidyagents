import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { lintText, applyFixes, findAgentFiles, badgeMarkdown } from '../src/lint.js';

const BIN = new URL('../bin/tidyagents.js', import.meta.url).pathname;

function tempRepo(files) {
  const root = mkdtempSync(join(tmpdir(), 'tidyagents-'));
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(join(root, path, '..'), { recursive: true });
    writeFileSync(join(root, path), content);
  }
  return root;
}

function lint(text, root = tempRepo({}), scripts = null) {
  return lintText(text, { fileDir: root, root, scripts });
}

const rules = (result) => result.issues.map((i) => i.rule);

test('a clean file scores 100', () => {
  const result = lint('# AGENTS.md\n\n- Run the tests before finishing.\n');
  assert.equal(result.score, 100);
  assert.deepEqual(result.issues, []);
});

test('flags missing paths, but not ones that exist', () => {
  const root = tempRepo({ 'src/app.js': '' });
  const result = lint('- Entry point is `src/app.js`\n- Deploy with `scripts/deploy.sh`\n', root);
  assert.deepEqual(rules(result), ['missing-path']);
  assert.equal(result.issues[0].line, 2);
  assert.deepEqual(result.issues[0].remove, [1]);
});

test('missing path in a paragraph is flagged but not auto-removed', () => {
  const result = lint('See `docs/gone.md` for the full guide and other notes.\n');
  assert.equal(result.issues[0].rule, 'missing-path');
  assert.equal(result.issues[0].remove, undefined);
});

test('ignores code spans that are not paths', () => {
  const result = lint('- Use `npm test`, `v1.2`, `--force`, `path/to/file` and `/usr/bin`.\n');
  assert.deepEqual(rules(result), []);
});

test('flags npm scripts missing from package.json', () => {
  const result = lint('- Run `npm run lint` then `npm run deploy`\n', undefined, { lint: 'eslint .' });
  assert.deepEqual(rules(result), ['missing-script']);
  assert.match(result.issues[0].message, /deploy/);
  assert.equal(result.issues[0].remove, undefined, 'line still has a working command, so keep it');
});

test('removes a bullet whose only reference is broken', () => {
  const result = lint('- Run `npm run deploy`\n', undefined, {});
  assert.deepEqual(result.issues[0].remove, [0]);
});

test('removes later duplicates, ignoring case and punctuation', () => {
  const text = '- Always run the tests first.\n- Something else entirely here\n- always run the tests first\n';
  const result = lint(text);
  assert.deepEqual(rules(result), ['duplicate']);
  assert.equal(applyFixes(text, result.issues), '- Always run the tests first.\n- Something else entirely here\n');
});

test('flags contradictions without fixing them', () => {
  const result = lint('- Always use semicolons\n\n- Never use semicolons\n');
  assert.deepEqual(rules(result), ['contradiction']);
  assert.equal(result.issues[0].remove, undefined);
});

test('flags vague rules', () => {
  assert.deepEqual(rules(lint('- Please follow best practices.\n')), ['vague']);
});

test('collapses runs of blank lines', () => {
  const text = '# Title\n\n\n\nBody text here.\n';
  const result = lint(text);
  assert.deepEqual(rules(result), ['blank-lines']);
  assert.equal(applyFixes(text, result.issues), '# Title\n\nBody text here.\n');
});

test('ignores content inside code fences', () => {
  const result = lint('```\nnpm run nope\n`missing/file.js`\n\n\n```\n', undefined, {});
  assert.deepEqual(rules(result), []);
});

test('preserves CRLF line endings when fixing', () => {
  const text = '- Keep this line please\r\n- Keep this line please\r\n';
  assert.equal(applyFixes(text, lint(text).issues), '- Keep this line please\r\n');
});

test('warns on large files', () => {
  const result = lint(`${'Some unique sentence number '.repeat(400)}\n`);
  assert.equal(result.issues[0].rule, 'size');
});

test('finds agent files and skips node_modules and hidden folders', () => {
  const root = tempRepo({
    'AGENTS.md': '',
    'packages/api/CLAUDE.md': '',
    '.claude/skills/x/SKILL.md': '',
    '.github/copilot-instructions.md': '',
    'node_modules/pkg/AGENTS.md': '',
    '.cache/AGENTS.md': '',
  });
  const found = findAgentFiles(root).map((p) => p.slice(root.length + 1)).sort();
  assert.deepEqual(found, ['.claude/skills/x/SKILL.md', '.github/copilot-instructions.md', 'AGENTS.md', 'packages/api/CLAUDE.md']);
});

test('badge color follows score', () => {
  assert.match(badgeMarkdown(95), /95%2F100-brightgreen/);
  assert.match(badgeMarkdown(40), /40%2F100-red/);
});

const cli = (root, ...args) => spawnSync('node', [BIN, ...args], { cwd: root, encoding: 'utf8' });

test('cli: --min-score fails the build and --json reports issues', () => {
  const root = tempRepo({ 'CLAUDE.md': '- See `gone.md`\n' });
  assert.equal(cli(root, '--min-score', '95').status, 1);
  const json = JSON.parse(cli(root, '--json').stdout);
  assert.equal(json.score, 90);
  assert.equal(json.files[0].issues[0].fixable, true);
});

test('cli: fix is a dry run without --yes, and writes with it', () => {
  const root = tempRepo({ 'AGENTS.md': '- Run the full test suite\n- Run the full test suite\n' });
  assert.match(cli(root, 'fix').stdout, /Dry run/);
  assert.equal(readFileSync(join(root, 'AGENTS.md'), 'utf8').split('\n').length, 3);
  cli(root, 'fix', '--yes');
  assert.equal(readFileSync(join(root, 'AGENTS.md'), 'utf8'), '- Run the full test suite\n');
});

test('cli: init creates a starter that scores 100 and refuses to overwrite', () => {
  const root = tempRepo({ 'package.json': JSON.stringify({ scripts: { test: 'x', lint: 'y' } }) });
  assert.equal(cli(root, 'init').status, 0);
  assert.match(readFileSync(join(root, 'AGENTS.md'), 'utf8'), /npm run lint/);
  assert.equal(JSON.parse(cli(root, '--json').stdout).score, 100);
  assert.equal(cli(root, 'init').status, 2);
});

test('cli: unknown file is a usage error', () => {
  assert.equal(cli(tempRepo({}), 'nope.md').status, 2);
});
