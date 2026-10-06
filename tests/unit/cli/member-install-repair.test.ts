import { testEnv } from './member-test-env.js';
import { describe, it, expect, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, copyFileSync, chmodSync, symlinkSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { runInNewContext } from 'node:vm';

describe('member installation entrypoints', () => {
  it('the installer rejects unsupported dependency-engine boundaries without running installation', () => {
    const source = readFileSync('install.mjs', 'utf8');
    const predicate = source.match(/const supportedNode = ([\s\S]*?);/);
    expect(predicate).not.toBeNull();
    for (const [version, accepted] of [
      ['20.0', false], ['20.18', false], ['20.19', true], ['21.7', false],
      ['22.12', false], ['22.13', true], ['23.4', false], ['23.5', true], ['24.0', true],
    ] as const) {
      const [nodeMajor, nodeMinor] = version.split('.').map(Number);
      expect(runInNewContext(predicate![1], { nodeMajor, nodeMinor }), version).toBe(accepted);
    }
  });

  for (const command of ['restart', 'detect-chat-id']) {
    it(`ascendops exposes ${command} help without performing its action`, () => {
      const output = execFileSync(process.execPath, [
        join(process.cwd(), 'node_modules/tsx/dist/cli.mjs'),
        'src/cli/ascendops.ts', command, '--help',
      ], { encoding: 'utf8', timeout: 20000, env: testEnv({ CTX_ROOT: join(tmpdir(), 'unused-member-help-root') }) });
      expect(output).toContain(`Usage: ascendops ${command}`);
      expect(output).not.toContain('unknown command');
    }, 25000);
  }

  it('the plain-clone installer builds with the real guard before globally linking', () => {
    const root = mkdtempSync(join(tmpdir(), 'member-installer-e2e-'));
    const seed = join(root, 'seed');
    const checkout = join(root, 'checkout');
    const bin = join(root, 'bin');
    const home = join(root, 'home');
    for (const dir of [seed, bin, home, join(seed, 'scripts'), join(seed, 'installer')]) mkdirSync(dir);
    const env = testEnv({
      HOME: home, PATH: `${bin}:${dirname(process.execPath)}:/usr/bin:/bin`,
      ASCENDOPS_REPO: seed, ASCENDOPS_DIR: checkout, ASCENDOPS_UNATTENDED: '0',
      npm_config_prefix: join(root, 'prefix'), npm_config_cache: join(root, 'cache'),
      npm_config_audit: 'false', npm_config_fund: 'false',
    });
    const git = (...args: string[]) => execFileSync('git', args, { cwd: seed, env, encoding: 'utf8' });
    const fake = (name: string, body: string) => {
      const path = join(bin, name);
      writeFileSync(path, `#!/bin/sh\n${body}\n`); chmodSync(path, 0o755);
    };
    try {
      symlinkSync(process.execPath, join(bin, 'node'));
      fake('gh', 'exit 1');
      fake('claude', 'if [ "$1 $2" = "auth status" ]; then echo \'{"loggedIn":true}\'; else echo fixture; fi');
      for (const name of ['xcode-select', 'python3', 'jq', 'rtk', 'icm', 'brew', 'pm2']) fake(name, 'echo fixture');
      fake('dpkg', 'echo "ii build-essential fixture"');
      const pkg = {
        name: 'member-installer-fixture', version: '1.0.0', type: 'module',
        bin: { cortextos: 'dist/cli.js' },
        scripts: { prebuild: 'node scripts/prebuild-guard.mjs', build: 'node scripts/build.mjs' },
      };
      writeFileSync(join(seed, 'package.json'), JSON.stringify(pkg));
      writeFileSync(join(seed, 'package-lock.json'), JSON.stringify({
        name: pkg.name, version: pkg.version, lockfileVersion: 3, requires: true,
        packages: { '': { name: pkg.name, version: pkg.version, bin: pkg.bin } },
      }));
      writeFileSync(join(seed, '.gitignore'), 'node_modules/\ndist/\n');
      copyFileSync('scripts/prebuild-guard.mjs', join(seed, 'scripts/prebuild-guard.mjs'));
      copyFileSync('installer/consent-gate.mjs', join(seed, 'installer/consent-gate.mjs'));
      writeFileSync(join(seed, 'scripts/build.mjs'), `
        import { mkdirSync, writeFileSync } from 'node:fs';
        mkdirSync('dist', { recursive: true });
        writeFileSync('dist/cli.js', '#!/usr/bin/env node\\n');
        writeFileSync('dist/claude-preflight.js', 'export function applyUnattendedConsent() { return { ok: true, recorded: true }; }');
      `);
      git('init', '-b', 'main');
      git('config', 'user.name', 'Fixture Author'); git('config', 'user.email', 'fixture@example.invalid');
      git('add', '.'); git('commit', '-m', 'installer fixture');
      const output = execFileSync(process.execPath, ['install.mjs'], {
        env, encoding: 'utf8', timeout: 60000, stdio: ['ignore', 'pipe', 'pipe'],
      });
      const remotes = execFileSync('git', ['remote'], { cwd: checkout, env, encoding: 'utf8' });
      expect(remotes.trim()).toBe('upstream');
      expect(output).toContain('Build allowed in isolated checkout');
      expect(output.indexOf('Build complete')).toBeLessThan(output.indexOf('Linking cortextos CLI'));
      expect(output).toContain('AscendOps installed successfully');
      expect(readFileSync(join(checkout, 'scripts/prebuild-guard.mjs'), 'utf8')).toBe(readFileSync('scripts/prebuild-guard.mjs', 'utf8'));
      expect(readFileSync(join(checkout, 'dist/cli.js'), 'utf8')).toContain('#!/usr/bin/env node');
    } finally { rmSync(root, { recursive: true, force: true }); }
  }, 65000);

  it('test child environment excludes a fake parent sentinel', () => {
    vi.stubEnv('MEMBER_TEST_PARENT_SENTINEL', 'fake-parent-sentinel');
    try {
      const output = execFileSync(process.execPath, ['-e',
        'process.stdout.write(String(Object.hasOwn(process.env, "MEMBER_TEST_PARENT_SENTINEL")))'],
        { encoding: 'utf8', env: testEnv() });
      expect(output === 'false').toBe(true);
    } finally { vi.unstubAllEnvs(); }
  });
});
