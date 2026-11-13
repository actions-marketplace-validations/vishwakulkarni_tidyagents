// Copies the linter, license and icon from the repo root into the extension, so the
// packaged extension ships the same src/lint.js as the CLI. `.mjs` keeps it ESM here.
import { copyFileSync, mkdirSync } from 'node:fs';

const from = (path) => new URL(`../${path}`, import.meta.url);
const to = (path) => new URL(path, import.meta.url);

mkdirSync(to('lib'), { recursive: true });
copyFileSync(from('src/lint.js'), to('lib/lint.mjs'));
copyFileSync(from('LICENSE'), to('LICENSE'));
copyFileSync(from('NOTICE'), to('NOTICE'));
copyFileSync(from('docs/logo/icon-512.png'), to('icon.png'));
