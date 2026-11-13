import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, realpathSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { lintText, lintFile, lintRepo, applyFixes, findAgentFiles, badgeMarkdown } from '../src/lint.js';

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
const SKILL_FM = '---\nname: x\ndescription: Does x. Use when the user asks for x.\n---\n';

test('a clean file scores 100', () => {
  const result = lint('# AGENTS.md\n\n- Run the tests before finishing.\n');
  assert.equal(result.score, 100);
  assert.deepEqual(result.issues, []);
});

test('flags missing paths, but not ones that exist', () => {
  const root = tempRepo({ 'src/app.js': '' });
  const result = lint('- Entry point is `src/app.js`\n- Old entry was `src/old.js`\n', root);
  assert.deepEqual(rules(result), ['missing-path']);
  assert.equal(result.issues[0].line, 2);
  assert.equal(result.issues[0].remove, undefined, 'may be a file the agent should create');
});

test('only checks paths whose top folder exists', () => {
  const root = tempRepo({ 'src/app.js': '' });
  const text = '- `kebab-case.ts`, `client.beta.files`, `next/root-params`, `scripts/example.py`, `node_modules/x/y.js`\n';
  assert.deepEqual(rules(lint(text, root)), []);
});

test('skips gitignored paths, files to create, examples and elided paths', () => {
  const root = tempRepo({ 'src/app.js': '', 'web/index.html': '', '.gitignore': 'dist/\n' });
  spawnSync('git', ['init', '-q'], { cwd: root });
  mkdirSync(join(root, 'dist'));
  const text = [
    '- Build output goes to `dist/bundle.js`',
    '- The web build lands in `web/dist`',
    '- Create `src/parsers/newtool.ts` for a new parser',
    '- Exchanges live under `src/<x>/` (e.g., `src/alpaca/`)',
    '- Tests mirror `src/.../thing.ts`',
    '- Hooks run from `.git/hooks/pre-commit`',
  ].join('\n');
  assert.deepEqual(rules(lint(`${text}\n`, root)), []);
});

test('skips paths and links inside git submodules that are not checked out', () => {
  const root = tempRepo({ '.gitmodules': '[submodule "schema"]\n\tpath = vendor/osv-schema\n', 'vendor/osv-schema/.keep': '', 'src/a.js': '' });
  const text = '- Schema: `vendor/osv-schema/docs/schema.md`, [proto](vendor/osv-schema/x.proto)\n- Gone: `src/b.js`\n';
  assert.deepEqual(lint(text, root).issues.map((i) => [i.rule, i.line]), [['missing-path', 2]]);
});

test('skips per-package paths, other repos and files the agent writes', () => {
  const root = tempRepo({ '.claude-plugin/marketplace.json': '', 'legal/.claude-plugin/plugin.json': '', 'src/a.ts': '', 'eval/replay.md': '' });
  const text = [
    "- Match the plugin's own `.claude-plugin/plugin.json` field",
    "- Mirrors Sentry's parser (`src/sentry/utils/groupreference.py` in getsentry/sentry)",
    '- Your only outputs are words: entries in the log files (`lessons.md`,',
    '  `eval/shadow-log.md`); nothing else',
    '- Old helper `src/b.ts` is gone',
  ].join('\n');
  assert.deepEqual(lint(`${text}\n`, root).issues.map((i) => [i.rule, i.line]), [['missing-path', 5]]);
});

test('accepts module paths without an extension, and matches folder case exactly', () => {
  const root = tempRepo({ 'api/composer.ts': '', 'posthog/x.py': '' });
  const text = '- See `api/composer` and the `PostHog/posthog` repo\n- Gone: `api/runner`\n';
  assert.deepEqual(lint(text, root).issues.map((i) => [i.rule, i.line]), [['missing-path', 2]]);
});

test('skips path checks in SKILL.md, which describes other projects', () => {
  const root = tempRepo({ 'src/app.js': '', 'skills/x/SKILL.md': `${SKILL_FM}- Read \`src/missing.js\`\n` });
  assert.deepEqual(lintFile(join(root, 'skills/x/SKILL.md'), root).issues, []);
});

test('SKILL.md files get a bigger size budget', () => {
  const root = tempRepo({ 'skills/x/SKILL.md': `${SKILL_FM}${'Some unique sentence number '.repeat(400)}\n` });
  assert.deepEqual(lintFile(join(root, 'skills/x/SKILL.md'), root).issues, []);
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

test('accepts scripts from any package.json in a monorepo, and ignores flags', () => {
  const root = tempRepo({
    'package.json': '{"scripts":{}}',
    'packages/web/package.json': '{"scripts":{"type-check":"tsc"}}',
    'AGENTS.md': '- Run `pnpm run type-check`, or `npm run -T x` and `npm run test:` patterns\n',
  });
  assert.deepEqual(lintFile(join(root, 'AGENTS.md'), root).issues, []);
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

test('only flags duplicate bullets within one section', () => {
  const text = '## A\n- Seed display on screen\n**Must include this:**\n## B\n- Seed display on screen\n**Must include this:**\n';
  assert.deepEqual(rules(lint(text)), []);
});

test('ignores nested bullets and bold-label sections for duplicates', () => {
  const text = '- List page\n  - Root component\n- Edit page\n  - Root component\n\n**established:**\n- Total feedback at least three\n\n**deprecated:**\n- Total feedback at least three\n';
  assert.deepEqual(rules(lint(text)), []);
});

test('compares code spans exactly when looking for duplicates', () => {
  const text = '- `10-112998590-C-T`\n- `10:112998590-C-T`\n- `10:112998590:C:T`\n- `10:112998590:C:T`\n';
  assert.deepEqual(lint(text).issues.map((i) => [i.rule, i.line]), [['duplicate', 4]]);
});

test('a plain label line ending in a colon starts a new duplicate section', () => {
  const text = 'For prebuilt kits:\n\n1. SSH into the Pi to confirm it works\n\nFor DIY parts:\n\n1. SSH into the Pi to confirm it works\n';
  assert.deepEqual(rules(lint(text)), []);
  assert.deepEqual(rules(lint('- SSH into the Pi to confirm it works\n  continues here:\n- SSH into the Pi to confirm it works\n')), ['duplicate']);
  const emphasis = '**Internal summary** (for HR):\n- Header: work product header here\n\n*Outside counsel briefing:*\n- Header: work product header here\n';
  assert.deepEqual(rules(lint(emphasis)), []);
});

test('only checks npm and pnpm scripts, since yarn and bun also run binaries', () => {
  assert.deepEqual(rules(lint('- Run `yarn run tsc` and `bun run tool/x.ts`\n', undefined, {})), []);
});

test('does not treat matching open and close tags as duplicates', () => {
  assert.deepEqual(rules(lint('<adding-new-model>\nSteps go here.\n</adding-new-model>\n')), []);
});

test('ignores polarity without explicit always/never', () => {
  assert.deepEqual(rules(lint('Allowed augmentations:\n\nNot allowed augmentations:\n')), []);
});

test('ignores vague phrases inside a specific instruction', () => {
  const text = '- Follow best practices for the payments module by running the contract tests first\n';
  assert.deepEqual(rules(lint(text)), []);
});

test('does not treat repeated table headers as duplicates', () => {
  const table = '| Rule | Do | Dont do this |\n|---|---|---|\n| a | b | c |\n';
  assert.deepEqual(rules(lint(`${table}\n${table}`)), []);
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

test('finds agent files and skips node_modules, hidden, template and fixture folders', () => {
  const root = tempRepo({
    'AGENTS.md': '',
    'packages/api/CLAUDE.md': '',
    '.claude/skills/x/SKILL.md': '',
    '.cursor/skills/w/SKILL.md': '',
    '.github/copilot-instructions.md': '',
    'node_modules/pkg/AGENTS.md': '',
    '.cache/AGENTS.md': '',
    '.agents/skills/y/SKILL.md': '',
    '.codex/AGENTS.md': '',
    'skills/.curated/z/SKILL.md': '',
    'docs/.hidden/AGENTS.md': '',
    'src/templates/next-app/AGENTS.md': '',
    'tests/fixtures/broken/CLAUDE.md': '',
    'community-templates/x/AGENTS.md': '',
  });
  const found = findAgentFiles(root).map((p) => p.slice(root.length + 1)).sort();
  assert.deepEqual(found, [
    '.agents/skills/y/SKILL.md', '.claude/skills/x/SKILL.md', '.codex/AGENTS.md', '.cursor/skills/w/SKILL.md',
    '.github/copilot-instructions.md', 'AGENTS.md', 'packages/api/CLAUDE.md', 'skills/.curated/z/SKILL.md',
  ]);
});

test('finds rule folders, local and override files', () => {
  const root = tempRepo({
    'CLAUDE.local.md': '',
    'AGENTS.override.md': '',
    '.windsurfrules': '',
    '.claude/rules/testing.md': '',
    '.claude/rules/api/style.md': '',
    '.cursor/rules/react.mdc': '',
    '.cursor/rules/notes.txt': '',
    '.github/instructions/ts.instructions.md': '',
    '.github/instructions/README.md': '',
    '.clinerules/style.md': '',
    '.clinerules/workflows/release.md': '',
  });
  const found = findAgentFiles(root).map((p) => p.slice(root.length + 1)).sort();
  assert.deepEqual(found, [
    '.claude/rules/api/style.md', '.claude/rules/testing.md', '.clinerules/style.md', '.cursor/rules/react.mdc',
    '.github/instructions/ts.instructions.md', '.windsurfrules', 'AGENTS.override.md', 'CLAUDE.local.md',
  ]);
});

test('flags broken markdown links, relative to the file', () => {
  const root = tempRepo({ 'docs/guide.md': '', 'pkg/README.md': '', 'pkg/AGENTS.md': '' });
  const text = [
    '- See [guide](../docs/guide.md#setup) and [readme](README.md)',
    '- Old: [api](../docs/api.md) and [notes](NOTES.md)',
    '- Web: [site](https://x.dev), [top](#top), [mail](mailto:a@b.c), [tpl](<path>), [ex](path/to/file.md), [x](URL)',
    '- Built: [models](gen.md)',
  ].join('\n');
  writeFileSync(join(root, 'pkg/gen.md.j2'), '');
  const result = lintText(`${text}\n`, { fileDir: join(root, 'pkg'), root, scripts: null });
  assert.deepEqual(result.issues.map((i) => [i.rule, i.line]), [['missing-path', 2], ['missing-path', 2]]);
  assert.match(result.issues[0].message, /links to `\.\.\/docs\/api\.md`/);
});

test('checks links in SKILL.md against the skill folder', () => {
  const root = tempRepo({
    'skills/x/references/a.md': '',
    'skills/x/SKILL.md': `${SKILL_FM}- See [a](references/a.md) and [b](references/b.md)\n`,
  });
  assert.deepEqual(rules(lintFile(join(root, 'skills/x/SKILL.md'), root)), ['missing-path']);
});

test('flags broken @imports but not mentions, scopes or code spans', () => {
  const root = tempRepo({ 'docs/a.md': '', 'Design Docs/b.md': '', 'package.json': '{}' });
  const text = [
    '- Read @docs/a.md, @package.json and @Design\\ Docs/b.md',
    '- Gone: @docs/old.md and @NOTES.md',
    '- Ask @alice, install @types/node, email me@x.com, keep `@docs/literal.md`, home @~/.claude/x.md',
  ].join('\n');
  const result = lint(`${text}\n`, root);
  assert.deepEqual(result.issues.map((i) => [i.rule, i.line]), [['missing-import', 2], ['missing-import', 2]]);
  assert.match(result.issues[0].message, /@docs\/old\.md/);
});

test('counts @imported files toward size, once each and through nested imports', () => {
  const big = `${'Some unique sentence number '.repeat(200)}\n`;
  const root = tempRepo({
    'CLAUDE.md': '@AGENTS.md\n@docs/a.md\n',
    'AGENTS.md': 'Rules here, see @docs/a.md\n',
    'docs/a.md': `${big}@docs/b.md\n`.replace('@docs/b.md', '@b.md'),
    'docs/b.md': big,
  });
  const result = lintFile(join(root, 'CLAUDE.md'), root);
  assert.deepEqual(rules(result), ['size']);
  assert.match(result.issues[0].message, /of them from @imports/);
});

test('validates SKILL.md frontmatter', () => {
  const skill = (fm) => {
    const root = tempRepo({ 'skills/x/SKILL.md': `${fm}Body text.\n` });
    return lintFile(join(root, 'skills/x/SKILL.md'), root).issues.map((i) => [i.severity, i.message]);
  };
  assert.deepEqual(skill(SKILL_FM), []);
  assert.match(skill('Body only\n')[0][1], /no `description`/);
  assert.match(skill('---\nname: x\n')[0][1], /never closed/);
  assert.deepEqual(skill('---\nname: Review-Code\ndescription: Reviews code.\n---\n')[0][0], 'warn');
  assert.deepEqual(skill('---\nname: <x>\ndescription: Reviews code.\n---\n')[0][0], 'error');
  assert.match(skill(`---\nname: x\ndescription: >\n  ${'word '.repeat(220)}\n---\n`)[0][1], /spec allows 1,024/);
  assert.match(skill(`---\nname: x\ndescription: ${'a'.repeat(1000)}\nwhen_to_use: ${'b'.repeat(600)}\n---\n`)[0][1], /cuts it at 1,536/);
});

test('skips frontmatter in line rules', () => {
  const text = '---\ndescription: follow best practices\nglobs: src/gone/*.ts\n---\n- Body rule that is specific enough\n';
  assert.deepEqual(rules(lint(text, tempRepo({ 'src/a.js': '' }))), []);
});

test('honors tidyagents-disable comments', () => {
  const text = [
    '<!-- tidyagents-disable-next-line vague -->',
    '- Follow best practices.',
    '<!-- tidyagents-disable-next-line duplicate -->',
    '- Write clean code',
    '- Write clean code',
  ].join('\n');
  const result = lint(`${text}\n`);
  assert.deepEqual(result.issues.map((i) => [i.rule, i.line]), [['vague', 4], ['vague', 5], ['duplicate', 5]]);
  assert.deepEqual(rules(lint(`<!-- tidyagents-disable-file vague, duplicate -->\n${text}\n`)), []);
  assert.deepEqual(rules(lint(`<!-- tidyagents-disable-file -->\n${text}\n`)), []);
});

test('hints at AGENTS.md only when a repo has .cursorrules without one', () => {
  const cursorOnly = tempRepo({ '.cursorrules': '- A rule here\n' });
  const result = lintFile(join(cursorOnly, '.cursorrules'), cursorOnly);
  assert.deepEqual(rules(result), ['no-agents-md']);
  assert.equal(result.issues[0].severity, 'info');
  const both = tempRepo({ '.cursorrules': '- A rule here\n', 'AGENTS.md': '- A rule here\n' });
  assert.deepEqual(rules(lintFile(join(both, '.cursorrules'), both)), []);
  const claude = tempRepo({ 'CLAUDE.md': '- A rule here\n' });
  assert.deepEqual(rules(lintFile(join(claude, 'CLAUDE.md'), claude)), []);
});

test('warns when CLAUDE.md shadows an AGENTS.md it never mentions', () => {
  const shadowed = tempRepo({ 'AGENTS.md': '- A rule here\n', 'CLAUDE.md': '- Another rule\n' });
  assert.deepEqual(rules(lintFile(join(shadowed, 'AGENTS.md'), shadowed)), ['shadowed']);
  const imported = tempRepo({ 'AGENTS.md': '- A rule here\n', '.claude/CLAUDE.md': '@../AGENTS.md\n' });
  assert.deepEqual(rules(lintFile(join(imported, 'AGENTS.md'), imported)), []);
  const linked = tempRepo({ 'AGENTS.md': '- A rule here\n' });
  symlinkSync('AGENTS.md', join(linked, 'CLAUDE.md'));
  assert.deepEqual(rules(lintFile(join(linked, 'AGENTS.md'), linked)), []);
  assert.deepEqual(findAgentFiles(linked).map((p) => p.slice(linked.length + 1)), ['AGENTS.md'], 'symlink checked once');
  const github = tempRepo({ 'CLAUDE.md': '- See [AGENTS.md](AGENTS.md)\n', 'AGENTS.md': '' });
  mkdirSync(join(github, '.github'));
  symlinkSync('../CLAUDE.md', join(github, '.github/copilot-instructions.md'));
  assert.deepEqual(findAgentFiles(github).map((p) => p.slice(github.length + 1)), ['AGENTS.md', 'CLAUDE.md'], 'linted under the real path');
  const copied = tempRepo({ 'AGENTS.md': '- A rule here\n', 'CLAUDE.md': '- A rule here\n' });
  assert.deepEqual(rules(lintFile(join(copied, 'AGENTS.md'), copied)), []);
  const body = Array.from({ length: 20 }, (_, n) => `- Rule number ${n} goes here`).join('\n');
  const retitled = tempRepo({ 'AGENTS.md': `# Notes for agents\n${body}\n`, 'CLAUDE.md': `# Notes for Claude\n${body}\n` });
  assert.deepEqual(rules(lintFile(join(retitled, 'AGENTS.md'), retitled)), [], 'only the title differs');
});

test('scoped rule files get the on-demand size budget', () => {
  const body = `${'Some unique sentence number '.repeat(400)}\n`;
  const size = (path, fm) => {
    const root = tempRepo({ [path]: `${fm}${body}` });
    return rules(lintFile(join(root, path), root));
  };
  assert.deepEqual(size('.github/instructions/ts.instructions.md', '---\napplyTo: "**/*.ts"\n---\n'), []);
  assert.deepEqual(size('.github/instructions/all.instructions.md', '---\napplyTo: "**"\n---\n'), ['size']);
  assert.deepEqual(size('.claude/rules/api.md', '---\npaths:\n  - src/api/**\n---\n'), []);
  assert.deepEqual(size('.claude/rules/all.md', ''), ['size']);
  assert.deepEqual(size('.cursor/rules/a.mdc', '---\nalwaysApply: true\n---\n'), ['size']);
  assert.deepEqual(size('.cursor/rules/b.mdc', '---\ndescription: React\nalwaysApply: false\n---\n'), []);
});

test('does not count imported agent files twice', () => {
  const root = tempRepo({ 'CLAUDE.md': '@AGENTS.md\n', 'AGENTS.md': `${'Some unique sentence number '.repeat(400)}\n` });
  assert.deepEqual(rules(lintFile(join(root, 'CLAUDE.md'), root)), []);
});

test('badge color follows score', () => {
  assert.match(badgeMarkdown(95), /95%2F100-brightgreen/);
  assert.match(badgeMarkdown(40), /40%2F100-red/);
});

const cli = (root, ...args) => spawnSync('node', [BIN, ...args], { cwd: root, encoding: 'utf8' });

test('cli: --min-score fails the build and --json reports issues', () => {
  const root = tempRepo({ 'CLAUDE.md': '- See `docs/gone.md`\n', 'docs/a.md': '' });
  assert.equal(cli(root, '--min-score', '95').status, 1);
  const json = JSON.parse(cli(root, '--json').stdout);
  assert.equal(json.score, 90);
  assert.equal(json.files[0].issues[0].fixable, false);
});

test('cli: --format github prints workflow annotations relative to the workspace', () => {
  const root = realpathSync(tempRepo({ 'pkg/CLAUDE.md': '- See `docs/gone.md`\n', 'pkg/docs/a.md': '' }));
  const result = spawnSync('node', [BIN, '--format', 'github'], {
    cwd: join(root, 'pkg'), encoding: 'utf8', env: { ...process.env, GITHUB_WORKSPACE: root },
  });
  assert.match(result.stdout, /^::error file=pkg\/CLAUDE\.md,line=1,title=tidyagents missing-path::references `docs\/gone\.md`/m);
  assert.match(result.stdout, /Score: 90\/100/, 'keeps the readable report in the log');
  assert.equal(cli(root, '--format', 'xml').status, 2);
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

test('cli: --json prints valid JSON when no files are found', () => {
  assert.deepEqual(JSON.parse(cli(tempRepo({}), '--json').stdout), { score: 100, files: [] });
});

test('cli: unknown file is a usage error', () => {
  assert.equal(cli(tempRepo({}), 'nope.md').status, 2);
});

test('missing-path names where a moved file went when exactly one tracked file has its name', () => {
  const root = tempRepo({ 'src/features/ConfigLoader.ts': '', 'src/a/util.ts': '', 'src/b/util.ts': '' });
  spawnSync('git', ['init', '-q'], { cwd: root });
  spawnSync('git', ['add', '.'], { cwd: root });
  const text = '- Config: `src/ConfigLoader.ts`\n- Helpers: `src/util.ts`\n- See [loader](src/ConfigLoader.ts)\n';
  const messages = lint(text, root).issues.map((i) => i.message);
  assert.deepEqual(messages, [
    'references `src/ConfigLoader.ts`, which does not exist; did you mean `src/features/ConfigLoader.ts`?',
    'references `src/util.ts`, which does not exist',
    'links to `src/ConfigLoader.ts`, which does not exist; did you mean `src/features/ConfigLoader.ts`?',
  ]);
});

test('lintRepo sees scripts added after an earlier run, for long-running hosts like editors', () => {
  const root = tempRepo({ 'package.json': '{"scripts":{}}', 'AGENTS.md': '- Test: `npm run test`\n' });
  assert.deepEqual(lintRepo(root).results[0].issues.map((i) => i.rule), ['missing-script']);
  writeFileSync(join(root, 'package.json'), '{"scripts":{"test":"node --test"}}');
  const { score, results } = lintRepo(root);
  assert.equal(score, 100);
  assert.equal(results[0].file, 'AGENTS.md');
});

test('the package entry point is the lint library', async () => {
  const lib = await import('tidyagents');
  assert.equal(typeof lib.lintRepo, 'function');
  assert.equal(typeof lib.lintText, 'function');
});

test('the VS Code extension and Orca plugin carry the CLI version, since one tag releases all three', () => {
  const version = (path) => JSON.parse(readFileSync(new URL(`../${path}`, import.meta.url), 'utf8')).version;
  assert.equal(version('vscode/package.json'), version('package.json'));
  assert.equal(version('orca-plugin.json'), version('package.json'));
});
