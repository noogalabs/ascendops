import { execFileSync, spawnSync } from 'child_process';
import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'fs';
import { tmpdir } from 'os';
import { delimiter, dirname, join, resolve } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { afterEach, describe, expect, it } from 'vitest';

const TEST_DIR = dirname(fileURLToPath(import.meta.url));
const SOURCE_ROOT = resolve(TEST_DIR, '..', '..');
const GUARD_SOURCE = join(SOURCE_ROOT, 'scripts', 'prebuild-guard.mjs');
const tempRoots: string[] = [];

function tempRoot(prefix: string): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  tempRoots.push(root);
  return root;
}

function git(root: string, args: string[]): string {
  return execFileSync('git', ['-C', root, ...args], { encoding: 'utf-8' }).trim();
}

function makeRepo(branch = 'feature/test', marker = false): { root: string; script: string } {
  const root = tempRoot('prebuild-guard-repo-');
  mkdirSync(join(root, 'scripts'), { recursive: true });
  copyFileSync(GUARD_SOURCE, join(root, 'scripts', 'prebuild-guard.mjs'));
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'cortextos' }));
  git(root, ['init', '-b', branch]);
  if (marker) writeFileSync(join(root, '.cortextos-live-tree'), '');
  return { root, script: join(root, 'scripts', 'prebuild-guard.mjs') };
}

function strippedEnv(extra: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
  const env = { ...process.env, ...extra };
  if (!Object.prototype.hasOwnProperty.call(extra, 'CI')) delete env.CI;
  if (!Object.prototype.hasOwnProperty.call(extra, 'GITHUB_ACTIONS')) delete env.GITHUB_ACTIONS;
  if (!Object.prototype.hasOwnProperty.call(extra, 'ALLOW_FEATURE_BUILD')) {
    delete env.ALLOW_FEATURE_BUILD;
  }
  return env;
}

function runGuard(
  script: string,
  env: NodeJS.ProcessEnv,
): ReturnType<typeof spawnSync> {
  return spawnSync(process.execPath, [script], { encoding: 'utf-8', env });
}

function output(result: ReturnType<typeof spawnSync>): string {
  return `${result.stdout || ''}\n${result.stderr || ''}`;
}

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe('prebuild live-tree guard', () => {
  it('blocks a marked live feature branch when CI variables are stripped', () => {
    const { script } = makeRepo('feature/unsafe', true);
    const result = runGuard(script, strippedEnv());

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('feature/unsafe');
    expect(result.stderr).toContain('main');
    expect(result.stderr).toContain('npx tsc --noEmit');
    expect(result.stderr).toContain('ALLOW_FEATURE_BUILD=1');
  });

  it('allows a marked live feature branch only with the explicit danger override', () => {
    const { script } = makeRepo('feature/override', true);
    const result = runGuard(script, strippedEnv({ ALLOW_FEATURE_BUILD: '1' }));

    expect(result.status).toBe(0);
    expect(output(result)).toContain('WARNING');
    expect(output(result)).toContain('feature/override');
  });

  it('allows a marked live main branch', () => {
    const { script } = makeRepo('main', true);
    const result = runGuard(script, strippedEnv());

    expect(result.status).toBe(0);
    expect(output(result)).toContain('live main');
  });

  it('allows CI on a marked live feature branch', () => {
    const { script } = makeRepo('feature/ci', true);
    const result = runGuard(script, strippedEnv({ CI: 'true' }));

    expect(result.status).toBe(0);
    expect(output(result)).toContain('CI');
  });

  it('allows an unmarked isolated feature clone and ignores the override there', () => {
    const { script } = makeRepo('feature/isolated', false);
    const result = runGuard(script, strippedEnv({ ALLOW_FEATURE_BUILD: '1' }));

    expect(result.status).toBe(0);
    expect(output(result)).toContain('isolated checkout');
    expect(output(result)).not.toContain('DANGER override accepted');
  });

  it('blocks a detached marked live checkout', () => {
    const { root, script } = makeRepo('feature/detached', true);
    writeFileSync(join(root, 'tracked.txt'), 'tracked');
    git(root, ['add', 'tracked.txt']);
    git(root, ['-c', 'user.name=Guard Test', '-c', 'user.email=guard@localhost', 'commit', '-m', 'fixture']);
    git(root, ['checkout', '--detach']);

    const result = runGuard(script, strippedEnv());

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('detached');
  });

  it('keeps a linked worktree isolated from the live checkout marker', () => {
    const { root } = makeRepo('main', true);
    git(root, ['add', 'package.json', 'scripts/prebuild-guard.mjs']);
    git(root, ['-c', 'user.name=Guard Test', '-c', 'user.email=guard@localhost', 'commit', '-m', 'fixture']);
    const worktreeRoot = join(dirname(root), `${root.split('/').at(-1)}-worktree`);
    tempRoots.push(worktreeRoot);
    git(root, ['worktree', 'add', '-b', 'feature/worktree', worktreeRoot]);

    const result = runGuard(join(worktreeRoot, 'scripts', 'prebuild-guard.mjs'), strippedEnv());

    expect(result.status).toBe(0);
    expect(output(result)).toContain('isolated checkout');
    expect(output(result)).toContain('live detectors: none');
  });

  it('treats an absent cortextos command as a normal D2 no-signal result', () => {
    const { script } = makeRepo('feature/no-command', false);
    const emptyPath = tempRoot('prebuild-guard-empty-path-');

    const result = runGuard(script, strippedEnv({ PATH: emptyPath }));

    expect(result.status).toBe(0);
    expect(output(result)).toContain('isolated checkout');
    expect(output(result)).not.toMatch(/detector errors:.*D2 global-bin containment/);
  });

  it('runs and blocks through a symlinked repository path', () => {
    const { root } = makeRepo('feature/alias', true);
    const aliasRoot = join(dirname(root), `${root.split('/').at(-1)}-alias`);
    tempRoots.push(aliasRoot);
    symlinkSync(root, aliasRoot);

    const result = runGuard(join(aliasRoot, 'scripts', 'prebuild-guard.mjs'), strippedEnv());

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('feature/alias');
    expect(result.stderr).toContain('D3 explicit marker');
  });

  it('wires the guard into build, dev, and test lifecycle hooks', () => {
    const packageJson = JSON.parse(readFileSync(join(SOURCE_ROOT, 'package.json'), 'utf-8')) as {
      scripts: Record<string, string>;
    };

    expect(packageJson.scripts.prebuild).toContain('node scripts/prebuild-guard.mjs');
    expect(packageJson.scripts.predev).toContain('node scripts/prebuild-guard.mjs');
    expect(packageJson.scripts.pretest).toContain('node scripts/prebuild-guard.mjs');
  });

  it('detects live identity through real global-package and global-bin symlink chains', async () => {
    const repoRoot = tempRoot('prebuild-guard-live-');
    const prefix = tempRoot('prebuild-guard-prefix-');
    const binDir = tempRoot('prebuild-guard-bin-');
    const repoAlias = join(dirname(repoRoot), `${repoRoot.split('/').at(-1)}-alias`);
    tempRoots.push(repoAlias);
    mkdirSync(join(repoRoot, 'dist'), { recursive: true });
    writeFileSync(join(repoRoot, 'package.json'), JSON.stringify({ name: 'cortextos' }));
    writeFileSync(join(repoRoot, 'dist', 'cli.js'), '#!/usr/bin/env node\n');
    chmodSync(join(repoRoot, 'dist', 'cli.js'), 0o755);
    symlinkSync(repoRoot, repoAlias);
    mkdirSync(join(prefix, 'lib', 'node_modules'), { recursive: true });
    symlinkSync(repoAlias, join(prefix, 'lib', 'node_modules', 'cortextos'));
    symlinkSync(join(repoAlias, 'dist', 'cli.js'), join(binDir, 'cortextos'));

    const originalPrefix = process.env.npm_config_prefix;
    const originalPath = process.env.PATH;
    process.env.npm_config_prefix = prefix;
    process.env.PATH = `${binDir}${delimiter}${originalPath || ''}`;
    try {
      const { detectLiveTree } = await import(`${pathToFileURL(GUARD_SOURCE).href}?positive=${Date.now()}`);
      const result = detectLiveTree(repoRoot);
      expect(result.live).toBe(true);
      expect(result.signals).toEqual(expect.arrayContaining(['D1 global-package identity', 'D2 global-bin containment']));
    } finally {
      if (originalPrefix === undefined) delete process.env.npm_config_prefix;
      else process.env.npm_config_prefix = originalPrefix;
      if (originalPath === undefined) delete process.env.PATH;
      else process.env.PATH = originalPath;
    }
  });

  it('keeps decide pure and allows loudly when all detectors error', async () => {
    const { decide } = await import(`${pathToFileURL(GUARD_SOURCE).href}?decide=${Date.now()}`);
    expect(decide({ ci: false, live: false, branch: 'feature/test', override: true })).toEqual(expect.objectContaining({
      allow: true,
      code: 'isolated',
    }));

    const { script } = makeRepo('feature/errors', false);
    const result = runGuard(script, strippedEnv({ PATH: '' }));
    expect(result.status).toBe(0);
    expect(output(result)).toContain('detector errors');
    expect(output(result)).toContain('isolated checkout');
  });
});
