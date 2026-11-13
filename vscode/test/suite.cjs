const assert = require('node:assert/strict');
const { join } = require('node:path');
const vscode = require('vscode');

async function waitFor(check, what) {
  for (let i = 0; i < 100; i++) {
    const value = check();
    if (value) return value;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`timed out waiting for ${what}`);
}

const codes = (uri) => vscode.languages.getDiagnostics(uri).map((d) => d.code).sort();

exports.run = async () => {
  const root = vscode.workspace.workspaceFolders[0].uri.fsPath;
  const uri = vscode.Uri.file(join(root, 'AGENTS.md'));
  await waitFor(() => vscode.languages.getDiagnostics(uri).length, 'diagnostics');
  assert.deepEqual(codes(uri), ['duplicate', 'missing-script']);
  assert.equal(vscode.languages.getDiagnostics(uri).find((d) => d.code === 'duplicate').range.start.line, 3);

  // Unsaved edits are linted from the buffer.
  const editor = await vscode.window.showTextDocument(uri);
  await editor.edit((e) => e.insert(new vscode.Position(5, 0), '- Write clean code.\n'));
  await waitFor(() => codes(uri).includes('vague'), 'vague rule on unsaved text');

  // The quick fix on the duplicate line deletes it.
  const actions = await vscode.commands.executeCommand('vscode.executeCodeActionProvider', uri, new vscode.Range(3, 0, 3, 0));
  const fix = actions.find((a) => a.title.startsWith('Remove: repeats line 3'));
  assert.ok(fix, `quick fix offered; got ${actions.map((a) => a.title)}`);
  await vscode.workspace.applyEdit(fix.edit);
  assert.equal(editor.document.getText().match(/npm run test/g).length, 1);
  await waitFor(() => !codes(uri).includes('duplicate'), 'duplicate cleared');

  // Defining the script on disk clears missing-script after the debounced re-check.
  await editor.document.save();
  const pkg = vscode.Uri.file(join(root, 'package.json'));
  await vscode.workspace.fs.writeFile(pkg, Buffer.from('{"scripts":{"test":"node --test","typecheck":"tsc"}}'));
  await waitFor(() => !codes(uri).includes('missing-script'), 'missing-script cleared after package.json change');
};
