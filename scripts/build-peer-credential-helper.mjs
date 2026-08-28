import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const platform = process.env.CORTEXTOS_BUILD_PLATFORM || process.platform;
if (platform === 'win32') {
  console.log('[native-helper] skipped: win32 measured identity backend is not yet available; custody/reaper remain disabled');
  process.exit(0);
}
const source = resolve(root, 'src/native/peer-credentials.c');
const output = resolve(process.argv[2] ?? resolve(root, 'dist/native/peer-credentials'));
mkdirSync(dirname(output), { recursive: true });

const compiler = process.env.CC || 'cc';
const args = ['-std=c11', '-O2', '-Wall', '-Wextra', '-Werror', source, '-o', output];
const result = spawnSync(compiler, args, { stdio: 'inherit' });
if (result.error) throw result.error;
if (result.status !== 0) process.exit(result.status ?? 1);
chmodSync(output, 0o755);
