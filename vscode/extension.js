const vscode = require('vscode');
const { join } = require('node:path');
const { pathToFileURL } = require('node:url');

const SEVERITY = {
  error: vscode.DiagnosticSeverity.Error,
  warn: vscode.DiagnosticSeverity.Warning,
  info: vscode.DiagnosticSeverity.Information,
};
// Below this the status bar item turns yellow, matching the CLI and Action default.
const MIN_SCORE = 80;

let lib;
const diagnostics = vscode.languages.createDiagnosticCollection('tidyagents');
// Agent file path -> its workspace folder path, and folder path -> per-file scores.
const agentFiles = new Map();
const scores = new Map();
let status;

function toDiagnostics(text, issues) {
  const lines = text.split(/\r?\n/);
  return issues.map((issue) => {
    const line = issue.line ? Math.min(issue.line - 1, lines.length - 1) : 0;
    const range = new vscode.Range(line, 0, line, lines[line].length);
    const diagnostic = new vscode.Diagnostic(range, issue.message, SEVERITY[issue.severity]);
    diagnostic.source = 'tidyagents';
    diagnostic.code = issue.rule;
    return diagnostic;
  });
}

// Unsaved edits count: an open document is linted from its buffer, not from disk.
function lintDocument(document, root) {
  return lib.lintText(document.getText(), lib.lintOptions(document.uri.fsPath, root));
}

function checkFolder(folder) {
  const root = folder.uri.fsPath;
  const { results } = lib.lintRepo(root);
  for (const [path, owner] of agentFiles) {
    if (owner === root && !results.some((r) => r.path === path)) {
      agentFiles.delete(path);
      diagnostics.delete(vscode.Uri.file(path));
    }
  }
  const folderScores = new Map();
  for (const result of results) {
    agentFiles.set(result.path, root);
    const open = vscode.workspace.textDocuments.find((d) => d.uri.fsPath === result.path);
    const text = open ? open.getText() : result.text;
    const { score, issues } = open ? lintDocument(open, root) : result;
    folderScores.set(result.path, score);
    diagnostics.set(vscode.Uri.file(result.path), toDiagnostics(text, issues));
  }
  scores.set(root, folderScores);
}

function updateStatus() {
  const all = [...scores.values()].flatMap((m) => [...m.values()]);
  if (!all.length) return status.hide();
  const score = Math.min(...all);
  status.text = `$(checklist) agents ${score}`;
  status.tooltip = `tidyagents: agent files score ${score}/100 (lowest file). Click for the issues.`;
  status.backgroundColor = score < MIN_SCORE ? new vscode.ThemeColor('statusBarItem.warningBackground') : undefined;
  status.show();
}

function checkAll() {
  for (const folder of vscode.workspace.workspaceFolders ?? []) checkFolder(folder);
  updateStatus();
}

function lintOpenDocument(document) {
  const root = agentFiles.get(document.uri.fsPath);
  if (!root) return;
  const { score, issues } = lintDocument(document, root);
  diagnostics.set(document.uri, toDiagnostics(document.getText(), issues));
  scores.get(root)?.set(document.uri.fsPath, score);
  updateStatus();
}

function debounce(fn, ms) {
  const timers = new Map();
  return (key, ...args) => {
    clearTimeout(timers.get(key));
    timers.set(key, setTimeout(() => (timers.delete(key), fn(...args)), ms));
  };
}

// Deleting lines bottom-up keeps the earlier line numbers valid.
function deleteLines(document, lines) {
  const edit = new vscode.WorkspaceEdit();
  for (const line of [...new Set(lines)].sort((a, b) => b - a)) {
    if (line < document.lineCount) edit.delete(document.uri, document.lineAt(line).rangeIncludingLineBreak);
  }
  return edit;
}

function fixableIssues(document) {
  const root = agentFiles.get(document.uri.fsPath);
  return root ? lintDocument(document, root).issues.filter((i) => i.remove) : [];
}

class QuickFixes {
  provideCodeActions(document, range) {
    const fixable = fixableIssues(document);
    const here = fixable.filter((i) => i.line && range.intersection(document.lineAt(i.line - 1).range));
    const actions = here.map((issue) => {
      const action = new vscode.CodeAction(`Remove: ${issue.message}`, vscode.CodeActionKind.QuickFix);
      action.edit = deleteLines(document, issue.remove);
      action.isPreferred = true;
      return action;
    });
    if (fixable.length > 1) {
      const all = new vscode.CodeAction(`Apply all ${fixable.length} safe tidyagents fixes`, vscode.CodeActionKind.QuickFix);
      all.edit = deleteLines(document, fixable.flatMap((i) => i.remove));
      actions.push(all);
    }
    return actions;
  }
}

async function activate(context) {
  lib = await import(pathToFileURL(join(__dirname, 'lib', 'lint.mjs')).href);
  status = vscode.window.createStatusBarItem('tidyagents.score', vscode.StatusBarAlignment.Right, 100);
  status.name = 'tidyagents';
  status.command = 'workbench.actions.view.problems';

  // Any file created, deleted or renamed can make a path in an agent file stale or valid again.
  const recheck = debounce(checkAll, 1000);
  const relint = debounce(lintOpenDocument, 300);
  const watcher = vscode.workspace.createFileSystemWatcher('**/*', false, true, false);
  // Edits made outside the editor (an agent in a terminal) change scripts and agent files too.
  const contentWatcher = vscode.workspace.createFileSystemWatcher('**/{package.json,*.md,*.mdc,.cursorrules,.windsurfrules,.clinerules}', true, false, true);
  const isAgentFile = (document) => agentFiles.has(document.uri.fsPath);

  context.subscriptions.push(
    diagnostics,
    status,
    watcher,
    watcher.onDidCreate(() => recheck('all')),
    watcher.onDidDelete(() => recheck('all')),
    contentWatcher,
    contentWatcher.onDidChange(() => recheck('all')),
    vscode.workspace.onDidChangeTextDocument((e) => isAgentFile(e.document) && relint(e.document.uri.fsPath, e.document)),
    vscode.workspace.onDidChangeWorkspaceFolders(() => {
      scores.clear();
      recheck('all');
    }),
    vscode.languages.registerCodeActionsProvider({ scheme: 'file' }, new QuickFixes(), {
      providedCodeActionKinds: [vscode.CodeActionKind.QuickFix],
    }),
    vscode.commands.registerCommand('tidyagents.check', checkAll),
    vscode.commands.registerCommand('tidyagents.fixFile', async () => {
      const document = vscode.window.activeTextEditor?.document;
      const fixable = document ? fixableIssues(document) : [];
      if (!fixable.length) return vscode.window.showInformationMessage('tidyagents: nothing to fix automatically in this file.');
      await vscode.workspace.applyEdit(deleteLines(document, fixable.flatMap((i) => i.remove)));
    }),
  );
  checkAll();
}

module.exports = { activate, deactivate() {} };
