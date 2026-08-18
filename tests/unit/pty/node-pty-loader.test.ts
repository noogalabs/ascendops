import { chmodSync, mkdirSync, mkdtempSync, statSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { rmSync } from 'fs';
import { repairNodePtySpawnHelpers } from '../../../src/pty/node-pty-loader.js';

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

  it('fails closed when the installed package contains no helper', () => {
    const root = mkdtempSync(join(tmpdir(), 'node-pty-loader-'));
    roots.push(root);
    expect(() => repairNodePtySpawnHelpers(root)).toThrow('found no spawn-helper');
  });
});
