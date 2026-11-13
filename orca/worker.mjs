// Orca plugin worker: scores the focused workspace's agent files in the status bar, and warns
// when an agent finishes and leaves a workspace's agent files below MIN_SCORE.
import { lintRepo } from '../src/lint.js';

// Matches the CLI and GitHub Action default.
const MIN_SCORE = 80;
const TONE = (score) => (score >= 90 ? 'success' : score >= MIN_SCORE ? 'neutral' : 'warning');

export function report(name, { score, results }) {
  if (!results.length) return `${name}: no agent instruction files found.`;
  const lines = [`${name}: ${score}/100`];
  for (const r of results) {
    if (!r.issues.length) continue;
    lines.push('', `${r.file}  ${r.score}/100`);
    for (const issue of r.issues) lines.push(`  ${issue.line ? `line ${issue.line}` : 'file'}: ${issue.message} [${issue.rule}]`);
  }
  const fixable = results.reduce((n, r) => n + r.issues.filter((i) => i.remove).length, 0);
  if (fixable) lines.push('', `${fixable} fixable: run \`npx tidyagents fix\` in the workspace.`);
  return lines.join('\n');
}

export default function activate(orca) {
  let focused = null;
  // Last score per workspace path, so a warning fires once when a workspace drops below MIN_SCORE.
  const lastScores = new Map();

  // Only workspaces on this machine: SSH and remote paths can't be read from here.
  async function findWorkspace(pick) {
    if (!pick) return null;
    const { workspaces } = await orca.host.call('workspace.list', {});
    const workspace = workspaces.find(pick);
    return workspace && (workspace.hostId === 'local' || workspace.hostId === null) ? workspace : null;
  }

  // Event ids are worktree ids (`<repoId>::<path>`); newer Orca also sends the list id.
  const byId = (id) => id && ((w) => w.id === id || id.endsWith(`::${w.path}`));
  // Before host API 1.7 the focused context has no id, only its name and branch.
  const byContext = (context) =>
    context && (byId(context.workspaceId) || ((w) => w.name === context.displayName && (w.branch ?? '') === context.branch));

  function lint(workspace) {
    const result = lintRepo(workspace.path);
    lastScores.set(workspace.path, result.score);
    return result;
  }

  function updateStatus(workspace, result) {
    if (!result?.results.length) return orca.host.call('statusBar.update', { id: 'score', visible: false });
    return orca.host.call('statusBar.update', {
      id: 'score',
      visible: true,
      text: `agents ${result.score}`,
      tone: TONE(result.score),
      tooltip: `tidyagents: ${workspace.name} agent files score ${result.score}/100 (lowest file). Click for the issues.`,
    });
  }

  async function showFocused() {
    const workspace = await findWorkspace(focused);
    return updateStatus(workspace, workspace && lint(workspace));
  }

  orca.events.on('workspace.changed', ({ context }) => {
    focused = byContext(context);
    return showFocused();
  });

  orca.events.on('agent.status.changed', async (payload) => {
    if (payload.state !== 'done') return;
    const workspace = await findWorkspace(byId(payload.workspaceListId ?? payload.workspaceId));
    if (!workspace) return;
    const before = lastScores.get(workspace.path);
    const result = lint(workspace);
    const { score, results } = result;
    if (results.length && score < MIN_SCORE && (before === undefined || before >= MIN_SCORE)) {
      await orca.host.call('notifications.show', {
        title: `tidyagents: ${workspace.name} agent files at ${score}/100`,
        body: 'An agent left stale paths or other issues in AGENTS.md, CLAUDE.md or similar. Run "tidyagents: Check agent files" to see them.',
      });
    }
    if (focused?.(workspace)) await updateStatus(workspace, result);
  });

  orca.commands.register('check', async () => {
    const workspace = await findWorkspace(focused);
    if (!workspace) return 'tidyagents: focus a workspace on this machine to check its agent files.';
    const result = lint(workspace);
    await updateStatus(workspace, result);
    return report(workspace.name, result);
  });
}
