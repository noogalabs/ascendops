import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { resolvePaths } from '../../../src/utils/paths.js';

describe('framework test isolation', () => {
  it('strips live fleet identity and root variables', () => {
    for (const name of [
      'CTX_AGENT_NAME',
      'CTX_ORG',
      'CTX_INSTANCE_ID',
      'CTX_ROOT',
      'CORTEXTOS_DIR',
      'CTX_AGENT_DIR',
      'CTX_PROJECT_ROOT',
      'CTX_FRAMEWORK_ROOT',
    ]) {
      expect(process.env[name], name).toBeUndefined();
    }
  });

  it('redirects in-process path resolution away from the real home', () => {
    expect(process.env.CTX_TEST_REAL_HOME).toBeTruthy();
    expect(homedir()).not.toBe(process.env.CTX_TEST_REAL_HOME);
    expect(resolvePaths('probe').ctxRoot.startsWith(homedir())).toBe(true);
  });

  it('redirects a real cortextos subprocess away from live state', () => {
    let binary = '';
    try {
      binary = execFileSync('/bin/sh', ['-c', 'command -v cortextos'], {
        encoding: 'utf8',
      }).trim();
    } catch {
      console.warn('SKIP: cortextos binary is not available on PATH');
      return;
    }
    if (!binary || !existsSync(binary)) {
      console.warn('SKIP: resolved cortextos binary does not exist');
      return;
    }

    const realHome = process.env.CTX_TEST_REAL_HOME ?? homedir();
    const fakeHome = homedir();
    execFileSync(
      'cortextos',
      ['bus', 'update-heartbeat', 'isolation-probe-status'],
      {
        env: {
          ...process.env,
          CTX_AGENT_NAME: 'isolation-probe',
          CTX_ORG: 'isolation-probe-org',
        },
      },
    );

    expect(
      existsSync(join(realHome, '.cortextos/default/state/isolation-probe')),
    ).toBe(false);
    expect(
      existsSync(join(fakeHome, '.cortextos/default/state/isolation-probe/heartbeat.json')),
    ).toBe(true);
  });
});
