import { chmodSync, mkdirSync, mkdtempSync, statSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { rmSync } from 'fs';
import { loadNodePty, prepareNodePtySpawn, repairNodePtySpawnHelpers } from '../../../src/pty/node-pty-loader.js';

const roots: string[] = [];

afterEach(() => {
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true });
});

describe('node-pty spawn-helper runtime repair', () => {
  it('repairs every packed and compiled helper before spawn use', () => {
    const root = mkdtempSync(join(tmpdir(), 'node-pty-loader-'));
    roots.push(root);
    const helpers = [
      join(root, 'prebuilds', 'darwin-arm64', 'spawn-helper'),
      join(root, 'prebuilds', 'darwin-x64', 'spawn-helper'),
      join(root, 'build', 'Release', 'spawn-helper'),
    ];
    for (const helper of helpers) {
      mkdirSync(join(helper, '..'), { recursive: true });
      writeFileSync(helper, '#!/bin/sh\nexit 0\n');
      chmodSync(helper, 0o600);
    }

    expect(repairNodePtySpawnHelpers(root)).toEqual([...helpers].sort());
    for (const helper of helpers) expect(statSync(helper).mode & 0o777).toBe(0o755);
  });

  it('repairs a helper re-armed after a cached spawn function was retained', () => {
    const root = mkdtempSync(join(tmpdir(), 'node-pty-loader-'));
    roots.push(root);
    const helper = join(root, 'prebuilds', 'darwin-arm64', 'spawn-helper');
    mkdirSync(join(helper, '..'), { recursive: true });
    writeFileSync(helper, '#!/bin/sh\nexit 0\n');
    chmodSync(helper, 0o600);

    const cachedSpawn = () => {
      if ((statSync(helper).mode & 0o111) === 0) throw new Error('posix_spawnp failed');
      return 'spawned';
    };

    repairNodePtySpawnHelpers(root);
    expect(cachedSpawn()).toBe('spawned');

    // Model a later fresh npm extraction while the production object retains
    // cachedSpawn. The second boundary must repair independently of loading.
    chmodSync(helper, 0o600);
    repairNodePtySpawnHelpers(root);
    expect(cachedSpawn()).toBe('spawned');
    expect(statSync(helper).mode & 0o777).toBe(0o755);
  });

  it('repairs the installed package when preparing a retained production spawn function', () => {
    const nodePty = loadNodePty();
    const helpers = [
      join(process.cwd(), 'node_modules', 'node-pty', 'prebuilds', 'darwin-arm64', 'spawn-helper'),
      join(process.cwd(), 'node_modules', 'node-pty', 'prebuilds', 'darwin-x64', 'spawn-helper'),
    ];
    for (const helper of helpers) chmodSync(helper, 0o600);

    expect(prepareNodePtySpawn(nodePty.spawn)).toBe(nodePty.spawn);
    for (const helper of helpers) expect(statSync(helper).mode & 0o777).toBe(0o755);
  });

  it('fails closed when the installed package contains no helper', () => {
    const root = mkdtempSync(join(tmpdir(), 'node-pty-loader-'));
    roots.push(root);
    expect(() => repairNodePtySpawnHelpers(root)).toThrow('found no spawn-helper');
  });
});
