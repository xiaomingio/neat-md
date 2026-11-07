/*
Publish the current version's packaged VSIX to the VS Code Marketplace.
The publishing token is supplied only through the VSCE_PAT environment variable.
*/
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const { name, version, publisher } = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));

if (!process.env.VSCE_PAT?.trim()) {
  console.error('VSCE_PAT must be supplied through the environment.');
  process.exit(1);
}

const vsix = join(root, 'release', `${name}-${version}.vsix`);
if (!existsSync(vsix)) {
  console.error(`Missing release/${name}-${version}.vsix. Run npm run package first.`);
  process.exit(1);
}

console.log(`Publishing ${publisher}.${name} ${version} from release/${name}-${version}.vsix`);
const result = spawnSync(process.execPath, [
  join(root, 'node_modules', '@vscode', 'vsce', 'vsce'),
  'publish', '--packagePath', vsix,
], { cwd: root, env: process.env, stdio: 'inherit' });

if (result.error) console.error(`Unable to run vsce: ${result.error.message}`);
process.exit(result.status ?? 1);
