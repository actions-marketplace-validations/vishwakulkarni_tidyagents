import { existsSync, readFileSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, basename, dirname, relative, isAbsolute, resolve } from 'node:path';

const AGENT_FILE_NAMES = new Set(['AGENTS.md', 'AGENTS.override.md', 'CLAUDE.md', 'CLAUDE.local.md', 'GEMINI.md', 'SKILL.md']);
const ROOT_ONLY_FILES = ['.cursorrules', '.windsurfrules', '.clinerules', '.github/copilot-instructions.md'];
// Folders of rule files at the repo root, which files in them each tool loads, and
// whether it looks in subfolders (Cline keeps on-demand workflows and hooks there).
const RULE_DIRS = [
  ['.claude/rules', /\.md$/, true],
  ['.cursor/rules', /\.mdc?$/, true],
  ['.github/instructions', /\.instructions\.md$/, true],
  ['.clinerules', /\.md$/, false],
  ['.windsurf/rules', /\.md$/, false],
];
const SKIP_DIRS = new Set(['node_modules', 'dist', 'build', 'vendor', 'target']);
// Agent files in these folders describe a generated app or a test case, not this repo,
// so their paths would all look stale. Pass the file by name to lint it anyway.
const TEMPLATE_DIRS = new Set(['templates', 'template', 'community-templates', 'fixtures', '__fixtures__', 'testdata']);
// Hidden folders that hold agent files: Claude Code, Cursor's `.cursor/skills`, and the shared
// `.agents/skills` of Codex and others.
const AGENT_DIRS = new Set(['.claude', '.cursor', '.agents', '.codex', '.gemini']);

const PENALTY = { error: 10, warn: 4, info: 1 };
const TOKENS_WARN = 2000;
const TOKENS_ERROR = 4000;
const SKILL_TOKENS_WARN = 5000;
const SKILL_TOKENS_ERROR = 10000;

const VAGUE_PHRASES = [
  'write good code',
  'write clean code',
  'follow best practices',
  'use best practices',
  'high quality code',
  'use common sense',
  'keep it clean',
];
const VAGUE_MAX_WORDS = 8;

const BULLET = /^\s*(?:[-*+]|\d+\.)\s+/;
const CODE_SPAN = /`([^`\n]+)`/g;
// Only npm and pnpm: `yarn run` and `bun run` also run binaries and files, not just scripts.
// Script names start and end with a word character, so "-T" and "test:" (a prefix) are skipped.
const RUN_SCRIPT = /\b(?:npm|pnpm) run (\w(?:[\w:.-]*\w)?)(?![\w:-])/g;
// Paths outside the repo's files, or elided examples like `src/.../x`.
const UNCHECKABLE_PATH = /^\.\.?\/|^\.git\/|^node_modules\/|\.\.\./;
// Lines about files to create, examples or optional files name paths that needn't exist.
// Judged over the whole bullet or paragraph, since sentences wrap across lines.
const NOT_A_REFERENCE = /\be\.g\.|\b(create[sd]?|generated?|if present|if it exists|outputs?|log files?|writes? (?:to|into))\b/i;
// "(`src/x.py` in getsentry/sentry)": a path in another repository.
const OTHER_REPO = /\b(?:in|from)\s+(?:the\s+)?([\w-]+)\/[\w.-]+/g;
const TOP_BULLET = /^(?:[-*+]|\d+\.)\s+/;
// A line that is only a bold label ("**proven:**") starts a new section, like a heading.
const BOLD_LABEL = /^\s*\*\*[^*]+\*\*:?\s*$/;
// So does an unindented plain line ending in a colon ("For DIY parts:").
// Bold and italic labels count too: "**Outside counsel** (handoff):", "*Recognize revenue:*".
const COLON_LABEL = /^(?![-*+]\s)[^\s|>#].*:[*_]*\s*$/;
// Contradictions are only judged between explicit rules ("always X" / "never X").
const NEGATIVE = /\b(never|dont|do not)\b/;
const POSITIVE = /\b(always|must)\b/;
const POLARITY_WORDS = /\b(always|never|must|should|not|do|dont|you|please)\b/g;
// Markdown links and images: [text](target "title").
const LINK = /!?\[[^\]]*\]\(\s*([^)\s]+)(?:\s+"[^"]*")?\s*\)/g;
// A target with a scheme (https:, mailto:), an anchor, or a placeholder is not a local file.
const NOT_A_FILE = /^[a-z][a-z\d+.-]*:|^#|[<>{}$*]/i;
// A target with neither a dot nor a slash is a placeholder like (URL), not a file.
const FILE_LIKE = /[./]/;
// `x.md` missing next to `x.md.j2` is generated from a template at build time.
const TEMPLATE_EXT = /^\.(j2|jinja2?|tmpl|tpl|template|hbs|ejs|njk|mustache|in)$/;
// Claude Code `@path` imports. Escaped spaces ("\ ") stay in the path; code spans are skipped.
const IMPORT = /(?:^|\s)@((?:\\ |[^\s\\])+)/g;
// A bare `@name` is usually a mention or decorator, so only file-like names count as imports.
const IMPORT_FILE = /\.(md|mdc|txt|json|ya?ml|toml)$/i;
const IMPORT_MAX_DEPTH = 4;
// <!-- tidyagents-disable-next-line rule ... --> and <!-- tidyagents-disable-file rule ... -->
const SUPPRESS = /<!--\s*tidyagents-disable-(next-line|file)\b(.*?)-->/;
// Agent Skills spec: lowercase letters, digits and single hyphens, at most 64 characters.
const SKILL_NAME = /^[\p{Ll}\p{Lo}\p{Nd}]+(?:-[\p{Ll}\p{Lo}\p{Nd}]+)*$/u;
const SKILL_DESCRIPTION_MAX = 1024;
// Claude Code truncates description + when_to_use at this length in its skill listing.
const SKILL_LISTING_MAX = 1536;

function findFiles(root, matches) {
  const found = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        // Skill catalogs keep tiers in hidden folders, like openai/skills' `skills/.curated/`.
        const hidden = entry.name.startsWith('.') && !AGENT_DIRS.has(entry.name) && basename(dir) !== 'skills';
        if (!hidden && !SKIP_DIRS.has(entry.name) && !TEMPLATE_DIRS.has(entry.name)) walk(join(dir, entry.name));
      } else if (entry.isFile() && matches(entry.name)) {
        found.push(join(dir, entry.name));
      }
    }
  };
  walk(root);
  return found;
}

const isFile = (path) => existsSync(path) && statSync(path).isFile();
const isDir = (path) => existsSync(path) && statSync(path).isDirectory();

export function findAgentFiles(root) {
  const rootOnly = ROOT_ONLY_FILES.map((p) => join(root, p)).filter(isFile);
  const rules = RULE_DIRS.flatMap(([dir, pattern, recursive]) => {
    const base = join(root, dir);
    if (!isDir(base)) return [];
    if (recursive) return findFiles(base, (name) => pattern.test(name));
    return readdirSync(base).filter((name) => pattern.test(name)).map((name) => join(base, name)).filter(isFile);
  });
  const named = findFiles(root, (name) => AGENT_FILE_NAMES.has(name));
  // Symlinked files (CLAUDE.md -> AGENTS.md) and folders are checked once, under the real path when
  // it was found too, so relative links resolve from the folder the content actually lives in.
  const realRoot = realpathSync(root);
  const isReal = (path) => realpathSync(path) === join(realRoot, relative(root, path));
  const byTarget = new Map();
  for (const path of [...rootOnly, ...rules, ...named].sort()) {
    const target = realpathSync(path);
    if (!byTarget.has(target) || (isReal(path) && !isReal(byTarget.get(target)))) byTarget.set(target, path);
  }
  return [...byTarget.values()].sort();
}

export function estimateTokens(text) {
  return Math.ceil(text.length / 4);
}

// Lowercased words only, so "Don't use X!" and "dont use x" compare equal.
function normalize(line) {
  return line
    .replace(BULLET, '')
    .toLowerCase()
    .replace(/['’]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

// A reference has rotted when its top folder exists but the rest is gone. Bare
// names, package names, URLs and example paths have no existing top folder, so
// they return null (not checkable) instead of a false alarm.
function pathExists(span, fileDir, root) {
  const bases = [fileDir, root];
  const path = span.replace(/^\.\//, '').replace(/\/$/, '');
  if (!/^[\w.\-/]+$/.test(path) || !path.includes('/') || UNCHECKABLE_PATH.test(path)) return null;
  const top = path.split('/')[0];
  // Exact case: on macOS `PostHog/posthog` would otherwise anchor on a `posthog/` folder.
  const anchored = top ? bases.filter((base) => isDir(base) && readdirSync(base).includes(top)) : [];
  if (!anchored.length) return null;
  if (anchored.some((base) => existsSync(join(base, path)) || isModulePath(join(base, path)))) return true;
  // Build output, caches and local config are gitignored: absent from a fresh clone by design.
  if (anchored.some((base) => isGitIgnored(base, path) || inSubmodule(root, join(base, path)))) return null;
  // A path that exists inside each package (`.claude-plugin/plugin.json`) names a per-folder convention.
  return packageDirs(root).some((dir) => existsSync(join(dir, path))) ? null : false;
}

// Folders one and two levels below the root: where packages and plugins live.
const packages = new Map();
function packageDirs(root) {
  if (!packages.has(root)) {
    const children = (dir) => readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory() && !e.name.startsWith('.') && !SKIP_DIRS.has(e.name))
      .map((e) => join(dir, e.name));
    const level1 = children(root);
    packages.set(root, [...level1, ...level1.flatMap(children)]);
  }
  return packages.get(root);
}

// Files git tracks, for pointing a stale path at where its file went. Empty outside git.
const trackedFiles = new Map();
function repoFiles(root) {
  if (!trackedFiles.has(root)) {
    const out = spawnSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
    trackedFiles.set(root, out.status === 0 ? out.stdout.split('\0').filter(Boolean) : []);
  }
  return trackedFiles.get(root);
}

// "; did you mean `new/path.ts`?" when exactly one tracked file has the missing file's name.
function movedHint(target, root) {
  const name = basename(target.replace(/[?#].*$/, ''));
  if (!name.includes('.')) return '';
  const matches = repoFiles(root).filter((f) => f === name || f.endsWith(`/${name}`));
  return matches.length === 1 ? `; did you mean \`${matches[0]}\`?` : '';
}

// True when the line names another repository ("in owner/repo") whose owner isn't a local folder.
function mentionsOtherRepo(line, fileDir, root) {
  for (const [, owner] of line.replace(CODE_SPAN, ' ').matchAll(OTHER_REPO)) {
    if (!existsSync(join(fileDir, owner)) && !existsSync(join(root, owner))) return true;
  }
  return false;
}

// Submodules are empty until `git submodule update`, as in most CI checkouts, so
// paths inside them can't be checked. Their paths come from the root .gitmodules.
const submodules = new Map();
function inSubmodule(root, full) {
  if (!submodules.has(root)) {
    const file = join(root, '.gitmodules');
    const text = isFile(file) ? readFileSync(file, 'utf8') : '';
    submodules.set(root, [...text.matchAll(/^\s*path\s*=\s*(.+?)\s*$/gm)].map(([, p]) => resolve(root, p)));
  }
  const target = resolve(full);
  return submodules.get(root).some((dir) => target === dir || target.startsWith(`${dir}/`) || target.startsWith(`${dir}\\`));
}

// The trailing-slash form matches folder patterns like `dist/` for folders that don't exist.
function isGitIgnored(base, path) {
  return [path, `${path}/`].some(
    (p) => spawnSync('git', ['check-ignore', '-q', '--no-index', p], { cwd: base }).status === 0,
  );
}

// Links and imports resolve from the file that contains them. Like pathExists, a
// target is only checkable when the folder it hangs off exists; outside the repo,
// gitignored or placeholder targets return null.
function localFileExists(target, fileDir, root) {
  if (NOT_A_FILE.test(target) || !FILE_LIKE.test(target) || target.startsWith('/') || target.startsWith('~')) return null;
  let decoded;
  try {
    decoded = decodeURIComponent(target.replace(/[?#].*$/, ''));
  } catch {
    return null;
  }
  const parts = decoded.split('/').filter((p) => p && p !== '.');
  if (!parts.length) return null;
  const full = resolve(fileDir, ...parts);
  const rel = relative(root, full);
  if (rel.startsWith('..') || isAbsolute(rel) || UNCHECKABLE_PATH.test(rel.split('\\').join('/'))) return null;
  if (existsSync(full)) return true;
  let up = 0;
  while (parts[up] === '..') up++;
  if (!existsSync(resolve(fileDir, ...parts.slice(0, Math.min(up + 1, parts.length - 1))))) return null;
  if (isGenerated(full) || inSubmodule(root, full)) return null;
  return isGitIgnored(root, rel) ? null : false;
}

// Code imports name modules without their extension: `api/composer` is `api/composer.ts`.
function isModulePath(full) {
  const name = basename(full);
  if (name.includes('.') || !isDir(dirname(full))) return false;
  return readdirSync(dirname(full)).some((f) => f.startsWith(`${name}.`) && !f.slice(name.length + 1).includes('.'));
}

function isGenerated(full) {
  const dir = dirname(full);
  const name = basename(full);
  return isDir(dir) && readdirSync(dir).some((f) => f.startsWith(`${name}.`) && TEMPLATE_EXT.test(f.slice(name.length)));
}

// `@path` imports on a line, outside code spans. Home and absolute paths are skipped:
// they live outside the repo and won't exist on another machine or in CI.
function importsOn(line) {
  const found = [];
  for (const [, raw] of line.replace(CODE_SPAN, ' ').matchAll(IMPORT)) {
    const path = raw.replace(/[.,;:!?)\]]+$/, '').replace(/\\ /g, ' ');
    if (path.startsWith('~') || path.startsWith('/')) continue;
    if (path.includes('/') || IMPORT_FILE.test(path)) found.push(path);
  }
  return found;
}

// Imported files load with the file that imports them, so they count toward its
// size: each file once, following nested imports up to Claude Code's four hops.
function importedTokens(lines, dir, root, seen, depth = 0) {
  if (depth >= IMPORT_MAX_DEPTH) return 0;
  const skipped = fencedLines(lines);
  let tokens = 0;
  lines.forEach((line, i) => {
    if (skipped[i]) return;
    for (const target of importsOn(line)) {
      const path = resolve(dir, target);
      // Imported agent files (CLAUDE.md: `@AGENTS.md`) get their own size check, so they aren't counted twice.
      if (AGENT_FILE_NAMES.has(basename(path))) continue;
      if (seen.has(path) || !localFileExists(target, dir, root) || !isFile(path)) continue;
      seen.add(path);
      const text = readFileSync(path, 'utf8');
      tokens += estimateTokens(text) + importedTokens(splitLines(text), dirname(path), root, seen, depth + 1);
    }
  });
  return tokens;
}

// Top-level `key: value` pairs of YAML frontmatter. Block scalars (| and >) and
// indented continuation lines are joined; nested maps aren't needed by any rule.
function parseFrontmatter(lines, end) {
  const fields = {};
  let current = null;
  for (let i = 1; i < end; i++) {
    const match = lines[i].match(/^([A-Za-z_][\w-]*):\s*(.*)$/);
    if (match) {
      const value = /^[|>][+-]?\d*$/.test(match[2]) ? '' : match[2].replace(/^(["'])(.*)\1$/, '$2');
      current = fields[match[1]] = { value, line: i };
    } else if (current && /^\s+\S/.test(lines[i])) {
      current.value = `${current.value} ${lines[i].trim()}`.trim();
    }
  }
  return fields;
}

// Frontmatter is the first line `---` through the next `---`; -1 means none.
function frontmatterEnd(lines) {
  if (lines[0]?.trim() !== '---') return -1;
  const end = lines.findIndex((line, i) => i > 0 && line.trim() === '---');
  return end;
}

function splitLines(text) {
  return text.replace(/\r?\n$/, '').split(/\r?\n/);
}

// Marks which lines sit inside fenced code blocks; rules ignore those lines.
function fencedLines(lines) {
  let inFence = false;
  return lines.map((line) => {
    if (/^\s*(```|~~~)/.test(line)) {
      inFence = !inFence;
      return true;
    }
    return inFence;
  });
}

export function lintText(text, { fileDir, root, scripts, onDemand = false, skill = onDemand, shadowedBy = null, cursorOnly = false, path = null }) {
  const lines = splitLines(text);
  const fenced = fencedLines(lines);
  const issues = [];
  const add = (rule, severity, index, message, remove) =>
    issues.push({ rule, severity, line: index === null ? null : index + 1, message, remove });

  // Frontmatter is metadata, not instructions: line rules skip it.
  const fmEnd = frontmatterEnd(lines);
  for (let i = 0; i <= fmEnd; i++) fenced[i] = true;
  if (skill) lintSkillFrontmatter(lines, fmEnd, add);
  const scoped = !skill && isScopedRule(path, fmEnd > 0 ? parseFrontmatter(lines, fmEnd) : {});

  if (shadowedBy) {
    add('shadowed', 'warn', null,
      `Claude Code reads ${shadowedBy} instead of this file; add \`@AGENTS.md\` to ${shadowedBy} so Claude gets these rules too`);
  }
  if (cursorOnly) {
    add('no-agents-md', 'info', null, 'only Cursor reads `.cursorrules`; move these rules to an `AGENTS.md` so other coding agents get them too');
  }

  // Skills and scoped rules load only when used, so they get a bigger budget than always-loaded files.
  const [warnAt, errorAt] = onDemand || scoped ? [SKILL_TOKENS_WARN, SKILL_TOKENS_ERROR] : [TOKENS_WARN, TOKENS_ERROR];
  const ownTokens = estimateTokens(text);
  const imported = skill ? 0 : importedTokens(lines, fileDir, root, new Set(path ? [resolve(path)] : []));
  const tokens = ownTokens + imported;
  if (tokens > warnAt) {
    const when = skill ? 'loaded every time this skill is used'
      : scoped ? 'loaded every time this rule applies' : 'loaded into every agent session';
    const from = imported ? `, ${imported.toLocaleString('en-US')} of them from @imports` : '';
    add('size', tokens > errorAt ? 'error' : 'warn', null,
      `${tokens.toLocaleString('en-US')} tokens${from}, ${when} (aim for under ${warnAt.toLocaleString('en-US')})`);
  }

  let seen = new Map();
  const polarity = new Map();
  let blankRun = [];

  const flushBlanks = () => {
    if (blankRun.length > 1) {
      add('blank-lines', 'info', blankRun[1], `${blankRun.length} blank lines in a row`, blankRun.slice(1));
    }
    blankRun = [];
  };

  let paragraph = '';
  lines.forEach((line, i) => {
    if (fenced[i]) return (paragraph = ''), flushBlanks();
    if (line.trim() === '') return (paragraph = ''), blankRun.push(i);
    flushBlanks();

    const isHeading = /^\s*#/.test(line);
    paragraph = isHeading || BULLET.test(line) ? line : `${paragraph} ${line}`;
    const reference = !NOT_A_REFERENCE.test(paragraph) && !mentionsOtherRepo(line, fileDir, root);
    if (isHeading || BOLD_LABEL.test(line) || (COLON_LABEL.test(line) && !BULLET.test(line))) seen = new Map();

    let workingRefs = 0;
    // Skills describe whatever project they run in, so their paths aren't checked.
    const checkPaths = !skill && reference;
    for (const [, span] of checkPaths ? line.matchAll(CODE_SPAN) : []) {
      const exists = pathExists(span, fileDir, root);
      if (exists) workingRefs++;
      // Never auto-removed: the line may describe a file the agent is meant to create.
      else if (exists === false) add('missing-path', 'error', i, `references \`${span}\`, which does not exist${movedHint(span, root)}`);
    }
    // Links are explicit file references, so they are checked in skills too (against the skill's folder).
    if (reference) {
      for (const [, target] of line.replace(CODE_SPAN, ' ').matchAll(LINK)) {
        const exists = localFileExists(target, fileDir, root);
        if (exists) workingRefs++;
        else if (exists === false) add('missing-path', 'error', i, `links to \`${target}\`, which does not exist${movedHint(target, root)}`);
      }
    }
    for (const target of checkPaths ? importsOn(line) : []) {
      const exists = localFileExists(target, fileDir, root);
      if (exists) workingRefs++;
      else if (exists === false) add('missing-import', 'error', i, `imports \`@${target}\`, which does not exist, so nothing is loaded`);
    }
    if (scripts) {
      const missing = [];
      for (const [, name] of line.matchAll(RUN_SCRIPT)) {
        if (name in scripts) workingRefs++;
        else missing.push(name);
      }
      // Only drop a bullet when everything it points at is gone; otherwise a human edits it.
      const removable = BULLET.test(line) && workingRefs === 0 ? [i] : undefined;
      for (const name of missing) add('missing-script', 'error', i, `runs script "${name}", which is not in package.json`, removable);
    }

    // Table rows repeat legitimately (shared headers like "| Rule | Do | Don't |").
    if (isHeading || /^\s*\|/.test(line)) return;
    const norm = normalize(line);

    // A short line that is nothing but a platitude; longer lines usually go on to be specific.
    if (norm.split(' ').length <= VAGUE_MAX_WORDS) {
      for (const phrase of VAGUE_PHRASES) {
        if (norm.includes(phrase)) add('vague', 'warn', i, `"${phrase}" is too vague for an agent to act on; name the concrete command or rule`);
      }
    }

    if (norm.length < 12) return;

    // Only top-level bullets repeated within one section: across sections, or nested
    // under different parents, repeats are usually deliberate.
    if (TOP_BULLET.test(line)) {
      // Code spans are compared exactly: `10-11-C` and `10:11:C` are different values.
      const key = `${normalize(line.replace(CODE_SPAN, ' '))}\0${[...line.matchAll(CODE_SPAN)].map((m) => m[1]).join('\0')}`;
      if (seen.has(key)) add('duplicate', 'warn', i, `repeats line ${seen.get(key) + 1} in the same section`, [i]);
      else seen.set(key, i);
    }

    const negative = NEGATIVE.test(norm);
    if (!negative && !POSITIVE.test(norm)) return;
    const subject = norm.replace(POLARITY_WORDS, ' ').replace(/\s+/g, ' ').trim();
    if (subject.length < 8) return;
    const other = polarity.get(subject);
    if (other && other.negative !== negative) {
      add('contradiction', 'error', i, `contradicts line ${other.index + 1}; keep one of them`);
    } else if (!other) {
      polarity.set(subject, { negative, index: i });
    }
  });
  flushBlanks();

  const kept = suppress(issues, lines, fencedLines(lines));
  kept.sort((a, b) => (a.line ?? 0) - (b.line ?? 0));
  const score = Math.max(0, 100 - kept.reduce((sum, issue) => sum + PENALTY[issue.severity], 0));
  return { tokens, score, issues: kept };
}

// Rule files load only for matching paths (Claude `paths`, Cursor `globs`, Copilot
// `applyTo`) or when the agent picks them by description, unless marked always-on.
function isScopedRule(path, fm) {
  if (fm.alwaysApply?.value === 'true') return false;
  if (fm.applyTo) return !/^\*\*(\/\*)?$/.test(fm.applyTo.value);
  if (fm.paths || fm.globs) return true;
  return Boolean(path && /\.(mdc|instructions\.md)$/.test(path));
}

// Inline opt-outs, like eslint and markdownlint. No rule names means every rule.
// HTML comments are stripped before Claude Code loads the file, so they cost no tokens.
function suppress(issues, lines, fenced) {
  const fileRules = [];
  const lineRules = new Map();
  lines.forEach((line, i) => {
    const match = !fenced[i] && line.match(SUPPRESS);
    if (!match) return;
    const named = match[2].split(/[\s,]+/).filter(Boolean);
    if (match[1] === 'file') fileRules.push(named);
    else lineRules.set(i + 2, named);
  });
  const covers = (named, rule) => !named.length || named.includes(rule);
  return issues.filter((issue) =>
    !fileRules.some((named) => covers(named, issue.rule)) &&
    !(lineRules.has(issue.line) && covers(lineRules.get(issue.line), issue.rule)));
}

// Claude Code accepts a skill without frontmatter, but agents then guess when to use it,
// and other tools following the Agent Skills spec reject bad names and long descriptions.
function lintSkillFrontmatter(lines, end, add) {
  if (lines[0]?.trim() === '---' && end === -1) {
    return add('skill-frontmatter', 'error', 0, 'frontmatter is never closed with `---`, so no field loads');
  }
  const fields = end === -1 ? {} : parseFrontmatter(lines, end);
  const { name, description } = fields;
  if (name && /[<>]|^\s|\s$|\s\s/.test(name.value)) {
    add('skill-frontmatter', 'error', name.line, `name "${name.value}" has characters that stop the skill from loading in Claude Code`);
  } else if (name && (!SKILL_NAME.test(name.value) || name.value.length > 64)) {
    add('skill-frontmatter', 'warn', name.line, `name "${name.value}" should be lowercase letters, digits and single hyphens, at most 64 characters`);
  }
  if (!description?.value) {
    add('skill-frontmatter', 'warn', description?.line ?? null, 'no `description`, so the agent has to guess when to use this skill');
    return;
  }
  const listing = description.value.length + (fields.when_to_use?.value.length ?? 0);
  if (listing > SKILL_LISTING_MAX) {
    add('skill-frontmatter', 'warn', description.line, `description is ${listing.toLocaleString('en-US')} characters; Claude Code cuts it at ${SKILL_LISTING_MAX.toLocaleString('en-US')}, so put the key use case first`);
  } else if (description.value.length > SKILL_DESCRIPTION_MAX) {
    add('skill-frontmatter', 'warn', description.line, `description is ${description.value.length.toLocaleString('en-US')} characters; the Agent Skills spec allows ${SKILL_DESCRIPTION_MAX.toLocaleString('en-US')}`);
  }
}

export function applyFixes(text, issues) {
  const remove = new Set(issues.flatMap((issue) => issue.remove ?? []));
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const kept = splitLines(text).filter((_, i) => !remove.has(i));
  return kept.join(eol) + (/\r?\n$/.test(text) ? eol : '');
}

function readPackageScripts(pkgPath) {
  try {
    return JSON.parse(readFileSync(pkgPath, 'utf8')).scripts ?? {};
  } catch {
    return null;
  }
}

export function readScripts(root) {
  const pkgPath = join(root, 'package.json');
  return existsSync(pkgPath) ? readPackageScripts(pkgPath) : null;
}

// In a monorepo an agent file may name any package's script, so a script only
// counts as missing when no package.json in the repo defines it.
const repoScripts = new Map();
function readRepoScripts(root) {
  if (!repoScripts.has(root)) {
    const all = findFiles(root, (name) => name === 'package.json').map(readPackageScripts).filter(Boolean);
    repoScripts.set(root, all.length ? Object.assign({}, ...all) : null);
  }
  return repoScripts.get(root);
}

// Copies that differ only in a line or two (usually the title) carry the same rules.
function nearlySame(a, b) {
  const [x, y] = [splitLines(a), splitLines(b)];
  const changed = x.filter((line, i) => line !== y[i]).length;
  return x.length === y.length && changed <= 2 && changed * 10 <= x.length;
}

// When a folder has both, Claude Code reads only CLAUDE.md. That is fine if CLAUDE.md
// imports or points at AGENTS.md; otherwise the two drift and Claude misses AGENTS.md.
function shadowingClaudeFile(path) {
  if (basename(path) !== 'AGENTS.md') return null;
  const dir = dirname(path);
  const claude = ['CLAUDE.md', '.claude/CLAUDE.md'].filter((p) => isFile(join(dir, p)));
  if (!claude.length) return null;
  const self = realpathSync(path);
  const own = readFileSync(path, 'utf8');
  // A symlink or an identical copy gives Claude the same rules.
  const pointsHere = (p) => {
    const text = readFileSync(join(dir, p), 'utf8');
    return realpathSync(join(dir, p)) === self || nearlySame(text, own) || text.includes('AGENTS.md');
  };
  return claude.some(pointsHere) ? null : claude[0];
}

export function lintOptions(path, root) {
  const onDemand = basename(path) === 'SKILL.md';
  // Skills run inside whatever project uses them, so this repo's scripts don't apply.
  return {
    fileDir: dirname(path), root, path, onDemand,
    scripts: onDemand ? null : readRepoScripts(root),
    shadowedBy: shadowingClaudeFile(path),
    cursorOnly: basename(path) === '.cursorrules' && !isFile(join(root, 'AGENTS.md')),
  };
}

export function lintFile(path, root) {
  const text = readFileSync(path, 'utf8');
  const result = lintText(text, lintOptions(path, root));
  const file = isAbsolute(path) ? relative(root, path) : path;
  return { file, path, text, ...result };
}

// The repo is only as healthy as its worst instruction file.
export function overallScore(results) {
  return results.length ? Math.min(...results.map((r) => r.score)) : 100;
}

// Lints every agent file in the repo (or the given files). Each call starts from fresh repo
// caches, so editors and other long-running hosts see renames, new scripts and new files.
export function lintRepo(root, files = null) {
  for (const cache of [packages, trackedFiles, submodules, repoScripts]) cache.delete(root);
  const results = (files ?? findAgentFiles(root)).map((file) => lintFile(file, root));
  return { score: overallScore(results), results };
}

export function badgeMarkdown(score) {
  const color = score >= 90 ? 'brightgreen' : score >= 70 ? 'yellow' : score >= 50 ? 'orange' : 'red';
  return `![tidyagents](https://img.shields.io/badge/tidyagents-${score}%2F100-${color})`;
}
