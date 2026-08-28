import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';

import { ecosystemCommand } from '../../../src/cli/ecosystem';

describe('ecosystem dashboard session boundary', () => {
  const originalFrameworkRoot = process.env.CTX_FRAMEWORK_ROOT;
  const originalHeartbeatSession = process.env.CTX_HEARTBEAT_SESSION;
  const roots: string[] = [];

  afterEach(() => {
    if (originalFrameworkRoot === undefined) delete process.env.CTX_FRAMEWORK_ROOT;
    else process.env.CTX_FRAMEWORK_ROOT = originalFrameworkRoot;
    if (originalHeartbeatSession === undefined) delete process.env.CTX_HEARTBEAT_SESSION;
    else process.env.CTX_HEARTBEAT_SESSION = originalHeartbeatSession;
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  it('the production ecosystem entry explicitly overrides an inherited heartbeat session with empty', async () => {
    const root = mkdtempSync(join(tmpdir(), 'ecosystem-dashboard-session-'));
    roots.push(root);
    mkdirSync(join(root, 'orgs', 'acme', 'agents', 'alpha'), { recursive: true });
    mkdirSync(join(root, 'dashboard', 'node_modules', '.bin'), { recursive: true });
    writeFileSync(join(root, 'dashboard', 'package.json'), '{}');
    writeFileSync(join(root, 'dashboard', 'node_modules', '.bin', 'next'), '');

    process.env.CTX_FRAMEWORK_ROOT = root;
    process.env.CTX_HEARTBEAT_SESSION = 'alpha:inherited-pm2-daemon-nonce';
    const output = join(root, 'ecosystem.config.cjs');
    await ecosystemCommand.parseAsync([
      'node', 'cortextos',
      '--instance', 'test',
      '--org', 'acme',
      '--output', output,
    ]);

    const generated = readFileSync(output, 'utf8');
    expect(generated).toContain("CTX_HEARTBEAT_SESSION: ''");

    const config = createRequire(import.meta.url)(output) as {
      apps: Array<{ name: string; env?: Record<string, string> }>;
    };
    const dashboard = config.apps.find(app => app.name === 'cortextos-dashboard');
    expect(dashboard?.env?.CTX_HEARTBEAT_SESSION).toBe('');
  });
});
