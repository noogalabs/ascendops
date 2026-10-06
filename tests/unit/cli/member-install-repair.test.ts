import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
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
      ], { encoding: 'utf8', timeout: 20000, env: { ...process.env, CTX_ROOT: join(tmpdir(), 'unused-member-help-root') } });
      expect(output).toContain(`Usage: ascendops ${command}`);
      expect(output).not.toContain('unknown command');
    }, 25000);
  }

});
