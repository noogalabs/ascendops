import { existsSync, readFileSync, realpathSync } from 'fs';
import { basename, dirname, join } from 'path';
import { execFileSync } from 'child_process';
import { homedir } from 'os';

function binaryCheckout(): string | undefined {
  try {
    const binary = realpathSync(process.argv[1]);
    if (basename(binary) !== 'ascendops.js') return undefined;
    return execFileSync('git', ['rev-parse', '--show-toplevel'], {
      cwd: dirname(binary), encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
    }).trim() || undefined;
  } catch { return undefined; }
}

/** Member CLI only: never fall back to a legacy checkout or unrelated cwd. */
export function resolveMemberCheckout(): string {
  const candidates = [process.env.ASCENDOPS_DIR, binaryCheckout(), join(homedir(), 'ascendops')];
  for (const candidate of candidates) {
    if (!candidate || !existsSync(join(candidate, 'package.json'))) continue;
    try {
      const pkg = JSON.parse(readFileSync(join(candidate, 'package.json'), 'utf8'));
      if (pkg.name === 'cortextos' || pkg.name === 'ascendops') return candidate;
    } catch { /* try the next install location */ }
  }
  throw new Error('AscendOps checkout not found. Set ASCENDOPS_DIR to your installation directory.');
}
