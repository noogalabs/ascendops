import { chmodSync, readdirSync, statSync } from 'fs';
import { dirname, join } from 'path';

interface NodePtyModule {
  spawn: (...args: any[]) => any;
}

type NodePtySpawn = NodePtyModule['spawn'];

let loadedPackageRoot: string | null = null;

function collectSpawnHelpers(directory: string, helpers: string[]): void {
  let entries: Array<{ name: string; isDirectory(): boolean; isFile(): boolean }>;
  try {
    entries = readdirSync(directory, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      collectSpawnHelpers(path, helpers);
    } else if (entry.isFile() && entry.name === 'spawn-helper') {
      helpers.push(path);
    }
  }
}

/**
 * Repair node-pty's npm-packed Darwin helpers at the first production spawn.
 * This is deliberately independent of package-manager lifecycle execution.
 */
export function repairNodePtySpawnHelpers(packageRoot: string): string[] {
  if (process.platform === 'win32') return [];

  const helpers: string[] = [];
  collectSpawnHelpers(join(packageRoot, 'prebuilds'), helpers);
  collectSpawnHelpers(join(packageRoot, 'build'), helpers);
  if (helpers.length === 0) {
    throw new Error('[node-pty] found no spawn-helper in the installed package');
  }

  for (const helper of helpers) {
    if ((statSync(helper).mode & 0o111) === 0) chmodSync(helper, 0o755);
    if ((statSync(helper).mode & 0o111) === 0) {
      throw new Error(`[node-pty] spawn-helper remains non-executable after repair: ${helper}`);
    }
  }
  return helpers.sort();
}

export function loadNodePty(): NodePtyModule {
  const packageJson = require.resolve('node-pty/package.json');
  loadedPackageRoot = dirname(packageJson);
  repairNodePtySpawnHelpers(loadedPackageRoot);
  return require('node-pty') as NodePtyModule;
}

/**
 * Cross the permission-repair door at every child spawn while retaining the
 * native module function cache. Injected test spawn functions have no loaded
 * package custody and therefore remain valid seams.
 */
export function prepareNodePtySpawn(cachedSpawn: NodePtySpawn | null): NodePtySpawn {
  if (!cachedSpawn) return loadNodePty().spawn;
  if (loadedPackageRoot) repairNodePtySpawnHelpers(loadedPackageRoot);
  return cachedSpawn;
}
