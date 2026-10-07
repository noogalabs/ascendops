import { afterEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, chmodSync, symlinkSync, accessSync, constants } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { stageMemberRuntime, publishMemberRuntime, pruneMemberRuntimeStages } from '../../../src/cli/member-runtime.js';
import { testEnv } from './member-test-env.js';

const roots: string[] = [];
afterEach(() => { vi.unstubAllEnvs(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function fixture(valid: boolean) {
  const root = mkdtempSync(join(tmpdir(), 'staged-member-')); roots.push(root);
  const env = testEnv();
  const git = (args: string[]) => execFileSync('git', args, { cwd: root, env, encoding: 'utf8' });
  git(['init', '-qb', 'main']); git(['config', 'user.name', 'Example']); git(['config', 'user.email', 'fixture@example.com']);
  const tsup = resolve('node_modules/tsup/dist/cli-default.js');
  writeFileSync(join(root, 'package.json'), JSON.stringify({ scripts: { build: `node ${JSON.stringify(tsup)} main.ts --format cjs --out-dir dist --clean` } }));
  writeFileSync(join(root, 'main.ts'), valid ? 'export const version = 2;' : 'export const version = ;');
  git(['add', '.']); git(['commit', '-qm', 'fixture']);
  for (const name of ['dist', 'node_modules']) { mkdirSync(join(root, name)); writeFileSync(join(root, name, 'old.txt'), `previous ${name}`); }
  const state = join(root, '.ascendops-update-backups'); mkdirSync(state);
  const bin = join(root, 'fake-bin'); mkdirSync(bin);
  const npm = execFileSync('which', ['npm'], { env, encoding: 'utf8' }).trim();
  writeFileSync(join(bin, 'npm'), `#!/bin/sh\nif [ "$1" = ci ]; then mkdir node_modules; printf staged > node_modules/new.txt; exit 0; fi\nexec "${npm}" "$@"\n`, { mode: 0o700 });
  vi.stubEnv('PATH', `${bin}:${env.PATH}`);
  return { root, state };
}

describe('staged member runtime', () => {
  it('a real compiler failure leaves installed dist and dependencies byte-identical', () => {
    const { root, state } = fixture(false);
    expect(() => stageMemberRuntime(root, state)).toThrow('Build failed');
    expect(readFileSync(join(root, 'dist', 'old.txt'), 'utf8')).toBe('previous dist');
    expect(readFileSync(join(root, 'node_modules', 'old.txt'), 'utf8')).toBe('previous node_modules');
  });
  it('publishes the successfully compiled pair and retains the previous pair for recovery', () => {
    const { root, state } = fixture(true);
    const stage = stageMemberRuntime(root, state);
    expect(readFileSync(join(root, 'dist', 'old.txt'), 'utf8')).toBe('previous dist');
    publishMemberRuntime(root, stage);
    expect(existsSync(join(root, 'dist', 'main.js'))).toBe(true);
    expect(readFileSync(join(root, 'node_modules', 'new.txt'), 'utf8')).toBe('staged');
    for (const name of ['dist', 'node_modules']) expect(readFileSync(join(stage, 'previous-runtime', name, 'old.txt'), 'utf8')).toBe(`previous ${name}`);
  });
  it('a failure publishing the second directory restores both previous directories', () => {
    const { root, state } = fixture(true);
    const stage = stageMemberRuntime(root, state);
    rmSync(join(stage, 'dist'), { recursive: true });
    expect(() => publishMemberRuntime(root, stage)).toThrow();
    for (const name of ['dist', 'node_modules']) expect(readFileSync(join(root, name, 'old.txt'), 'utf8')).toBe(`previous ${name}`);
    expect(existsSync(join(root, 'node_modules', 'new.txt'))).toBe(false);
  });
  it('cleanup skips links and active stages and never follows them to the running pair', () => {
    const { root, state } = fixture(true);
    const current = join(state, 'runtime-current'); mkdirSync(current); mkdirSync(join(current, 'previous-runtime'));
    const active = join(state, 'runtime-active'); mkdirSync(active); writeFileSync(join(active, 'building.txt'), 'active');
    symlinkSync(join(root, 'dist'), join(state, 'runtime-link'), 'dir');
    const old = join(state, 'runtime-old'); mkdirSync(old); mkdirSync(join(old, 'previous-runtime'));
    pruneMemberRuntimeStages(root, current);
    expect(existsSync(old)).toBe(false);
    expect(readFileSync(join(active, 'building.txt'), 'utf8')).toBe('active');
    expect(readFileSync(join(root, 'dist', 'old.txt'), 'utf8')).toBe('previous dist');
    expect(existsSync(join(current, 'previous-runtime'))).toBe(true);
  });
  it('cleanup permission failure logs and preserves both installed and previous pairs', () => {
    const { root, state } = fixture(true);
    const current = join(state, 'runtime-current'); mkdirSync(current); mkdirSync(join(current, 'previous-runtime'));
    const old = join(state, 'runtime-old'); mkdirSync(old); mkdirSync(join(old, 'previous-runtime'));
    chmodSync(state, 0o500);
    const output = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      expect(() => accessSync(state, constants.W_OK)).toThrow(expect.objectContaining({ code: 'EACCES' }));
      expect(() => pruneMemberRuntimeStages(root, current)).not.toThrow();
      expect(existsSync(old)).toBe(true);
      expect(existsSync(join(current, 'previous-runtime'))).toBe(true);
      for (const name of ['dist', 'node_modules']) expect(readFileSync(join(root, name, 'old.txt'), 'utf8')).toBe(`previous ${name}`);
      expect(output).toHaveBeenCalledWith(expect.stringContaining('cleanup skipped'));
    } finally { chmodSync(state, 0o700); output.mockRestore(); }
  });
});
