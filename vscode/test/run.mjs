// Launches a real VS Code with the extension on a throwaway repo and runs test/suite.cjs inside it.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runTests } from '@vscode/test-electron';

// Inside the gitignored .vscode-test folder: VS Code's file watcher reports nothing under the OS temp folder.
mkdirSync(new URL('../.vscode-test', import.meta.url), { recursive: true });
const workspace = mkdtempSync(fileURLToPath(new URL('../.vscode-test/workspace-', import.meta.url)));
writeFileSync(join(workspace, 'package.json'), '{"scripts":{"test":"node --test"}}');
writeFileSync(join(workspace, 'AGENTS.md'), '# AGENTS.md\n\n- Run `npm run test` before finishing.\n- Run `npm run test` before finishing.\n- Typecheck with `npm run typecheck`.\n');

try {
  await runTests({
    extensionDevelopmentPath: fileURLToPath(new URL('..', import.meta.url)),
    extensionTestsPath: fileURLToPath(new URL('suite.cjs', import.meta.url)),
    launchArgs: [workspace, '--disable-extensions', '--skip-welcome'],
  });
} finally {
  rmSync(workspace, { recursive: true, force: true });
}
