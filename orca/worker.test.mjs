// Run with `orca plugin test . --json`: `orca/testing` comes from the installed Orca.
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mountWorker, mockHost, test } from 'orca/testing';
import * as worker from './worker.mjs';

const AGENTS = (...scripts) => `# AGENTS.md\n\n${scripts.map((s) => `- Run \`npm run ${s}\`.`).join('\n')}\n`;

function setup(hostId = 'local') {
  const root = mkdtempSync(join(tmpdir(), 'tidyagents-orca-'));
  writeFileSync(join(root, 'package.json'), '{"scripts":{"test":"node --test"}}');
  writeFileSync(join(root, 'AGENTS.md'), AGENTS('test', 'typecheck'));
  const host = mockHost();
  host.respond('workspace.list', {
    workspaces: [
      { id: 'other', kind: 'worktree', name: 'main', path: '/elsewhere', branch: 'main', hostId: 'local' },
      { id: 'w1', kind: 'worktree', name: 'feature', path: root, branch: 'feature', hostId },
    ],
    truncated: false,
  });
  return { root, host, done: { workspaceId: `repo-1::${root}`, paneKey: 'p1', state: 'done', receivedAt: 1 } };
}

// The shape Orca 1.4.258 sends: no workspace id, so the worker matches name and branch.
const focus = { context: { branch: 'feature', displayName: 'feature', terminals: [] } };
const lastStatus = (host) => host.callsOf('statusBar.update').at(-1);

test('shows the focused workspace score in the status bar, and the issues on click', async () => {
  const { host } = setup();
  const w = await mountWorker(worker, { host });
  await w.emit('workspace.changed', focus);
  assert.deepEqual(w.refusals, []);
  assert.equal(lastStatus(host).text, 'agents 90');
  assert.equal(lastStatus(host).visible, true);
  const report = await w.command('check');
  assert.match(report, /^feature: 90\/100/);
  assert.match(report, /line 4: runs script "typecheck", which is not in package.json \[missing-script\]/);
});

test('warns once when an agent leaves the agent files below 80', async () => {
  const { root, host, done } = setup();
  const w = await mountWorker(worker, { host });
  await w.emit('workspace.changed', focus);
  writeFileSync(join(root, 'AGENTS.md'), AGENTS('test', 'typecheck', 'lint', 'build'));
  await w.emit('agent.status.changed', done);
  await w.emit('agent.status.changed', done);
  const notes = host.callsOf('notifications.show');
  assert.equal(notes.length, 1);
  assert.match(notes[0].title, /feature agent files at 70\/100/);
  assert.equal(lastStatus(host).text, 'agents 70');
  assert.equal(lastStatus(host).tone, 'warning');
});

test('hides the score for workspaces on other machines', async () => {
  const { host } = setup('ssh:devbox');
  const w = await mountWorker(worker, { host });
  await w.emit('workspace.changed', focus);
  assert.equal(lastStatus(host).visible, false);
  assert.match(await w.command('check'), /focus a workspace on this machine/);
});
