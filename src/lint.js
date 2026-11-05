import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, basename, dirname, relative, isAbsolute } from 'node:path';

const AGENT_FILE_NAMES = new Set(['AGENTS.md', 'CLAUDE.md', 'GEMINI.md', 'SKILL.md']);
const ROOT_ONLY_FILES = ['.cursorrules', '.github/copilot-instructions.md'];
const SKIP_DIRS = new Set(['node_modules', 'dist', 'build', 'vendor', 'target']);

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
const RUN_SCRIPT = /\b(?:npm|pnpm|yarn|bun) run ([\w:.-]+)/g;
// Contradictions are only judged between explicit rules ("always X" / "never X").
const NEGATIVE = /\b(never|dont|do not)\b/;
const POSITIVE = /\b(always|must)\b/;
const POLARITY_WORDS = /\b(always|never|must|should|not|do|dont|you|please)\b/g;

export function findAgentFiles(root) {
  const found = ROOT_ONLY_FILES.map((p) => join(root, p)).filter((p) => existsSync(p));
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        const hidden = entry.name.startsWith('.') && entry.name !== '.claude';
        if (!hidden && !SKIP_DIRS.has(entry.name)) walk(join(dir, entry.name));
      } else if (entry.isFile() && AGENT_FILE_NAMES.has(entry.name)) {
        found.push(join(dir, entry.name));
      }
    }
  };
  walk(root);
  return found.sort();
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
function pathExists(span, bases) {
  const path = span.replace(/^\.\//, '').replace(/\/$/, '');
  if (!/^[\w.\-/]+$/.test(path) || !path.includes('/') || path.startsWith('node_modules/')) return null;
  const top = path.split('/')[0];
  const anchored = top ? bases.filter((base) => existsSync(join(base, top))) : [];
  if (!anchored.length) return null;
  return anchored.some((base) => existsSync(join(base, path)));
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

export function lintText(text, { fileDir, root, scripts, onDemand = false }) {
  const lines = splitLines(text);
  const fenced = fencedLines(lines);
  const issues = [];
  const add = (rule, severity, index, message, remove) =>
    issues.push({ rule, severity, line: index === null ? null : index + 1, message, remove });

  // Skills load only when used, so they get a bigger budget than always-loaded files.
  const [warnAt, errorAt] = onDemand ? [SKILL_TOKENS_WARN, SKILL_TOKENS_ERROR] : [TOKENS_WARN, TOKENS_ERROR];
  const tokens = estimateTokens(text);
  if (tokens > warnAt) {
    const when = onDemand ? 'loaded every time this skill is used' : 'loaded into every agent session';
    add('size', tokens > errorAt ? 'error' : 'warn', null,
      `${tokens.toLocaleString('en-US')} tokens, ${when} (aim for under ${warnAt.toLocaleString('en-US')})`);
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

  lines.forEach((line, i) => {
    if (fenced[i]) return flushBlanks();
    if (line.trim() === '') return blankRun.push(i);
    flushBlanks();

    const isHeading = /^\s*#/.test(line);
    if (isHeading) seen = new Map();

    let workingRefs = 0;
    // Skills describe whatever project they run in, so their paths aren't checked.
    for (const [, span] of onDemand ? [] : line.matchAll(CODE_SPAN)) {
      const exists = pathExists(span, [fileDir, root]);
      if (exists) workingRefs++;
      // Never auto-removed: the line may describe a file the agent is meant to create.
      else if (exists === false) add('missing-path', 'error', i, `references \`${span}\`, which does not exist`);
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

    // Only bullets repeated within one section: across sections, repeats are usually deliberate.
    if (BULLET.test(line)) {
      if (seen.has(norm)) add('duplicate', 'warn', i, `repeats line ${seen.get(norm) + 1} in the same section`, [i]);
      else seen.set(norm, i);
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

  issues.sort((a, b) => (a.line ?? 0) - (b.line ?? 0));
  const score = Math.max(0, 100 - issues.reduce((sum, issue) => sum + PENALTY[issue.severity], 0));
  return { tokens, score, issues };
}

export function applyFixes(text, issues) {
  const remove = new Set(issues.flatMap((issue) => issue.remove ?? []));
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const kept = splitLines(text).filter((_, i) => !remove.has(i));
  return kept.join(eol) + (/\r?\n$/.test(text) ? eol : '');
}

export function readScripts(root) {
  const pkgPath = join(root, 'package.json');
  if (!existsSync(pkgPath)) return null;
  try {
    return JSON.parse(readFileSync(pkgPath, 'utf8')).scripts ?? {};
  } catch {
    return null;
  }
}

export function lintOptions(path, root) {
  return { fileDir: dirname(path), root, scripts: readScripts(root), onDemand: basename(path) === 'SKILL.md' };
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

export function badgeMarkdown(score) {
  const color = score >= 90 ? 'brightgreen' : score >= 70 ? 'yellow' : score >= 50 ? 'orange' : 'red';
  return `![tidyagents](https://img.shields.io/badge/tidyagents-${score}%2F100-${color})`;
}
