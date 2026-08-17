import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFile, execFileSync } from 'child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'fs';
import { homedir, tmpdir } from 'os';
import { join } from 'path';
import { promisify } from 'util';
import { randomBytes } from 'crypto';

const execFileAsync = promisify(execFile);
const REPO_ROOT = join(__dirname, '..', '..');
const DIST_CLI = join(REPO_ROOT, 'dist', 'cli.js');
const describeBuilt = existsSync(DIST_CLI) ? describe : describe.skip;

describeBuilt('auto-commit lease CLI', () => {
  let frameworkRoot: string;
  let ctxRoot: string;

  beforeEach(() => {
    frameworkRoot = mkdtempSync(join(tmpdir(), 'auto-commit-lease-cli-fw-'));
    ctxRoot = join(homedir(), '.cortextos', `lease-cli-${randomBytes(6).toString('hex')}`);
    for (const agent of ['alice', 'bob']) {
      const agentDir = join(frameworkRoot, 'orgs', 'acme', 'agents', agent);
      mkdirSync(agentDir, { recursive: true });
      writeFileSync(join(agentDir, 'config.json'), JSON.stringify({
        ecosystem: { local_version_control: { enabled: true, lease_ttl_ms: 600_000 } },
      }));
    }
    execFileSync('git', ['init'], { cwd: frameworkRoot, stdio: 'pipe' });
    execFileSync('git', ['config', 'user.email', 'test.invalid'], { cwd: frameworkRoot });
    execFileSync('git', ['config', 'user.name', 'Test'], { cwd: frameworkRoot });
    writeFileSync(join(frameworkRoot, '.gitkeep'), '');
    execFileSync('git', ['add', '.gitkeep', 'orgs'], { cwd: frameworkRoot });
    execFileSync('git', ['commit', '-m', 'init'], { cwd: frameworkRoot, stdio: 'pipe' });
  });

  afterEach(() => {
    rmSync(frameworkRoot, { recursive: true, force: true });
    rmSync(ctxRoot, { recursive: true, force: true });
  });

  async function run(agent: string, args: string[]) {
    const env = {
      ...process.env,
      CORTEXTOS_DIR: frameworkRoot,
      CTX_FRAMEWORK_ROOT: frameworkRoot,
      CTX_PROJECT_ROOT: frameworkRoot,
      CTX_ROOT: ctxRoot,
      CTX_INSTANCE_ID: ctxRoot.split('/').at(-1) as string,
      CTX_ORG: 'acme',
      CTX_AGENT_NAME: agent,
      CTX_AGENT_DIR: join(frameworkRoot, 'orgs', 'acme', 'agents', agent),
    };
    try {
      const { stdout, stderr } = await execFileAsync(process.execPath, [DIST_CLI, 'bus', ...args], { env });
      return { code: 0, stdout, stderr, json: JSON.parse(stdout) };
    } catch (error) {
      const err = error as { code?: number; stdout?: string; stderr?: string };
      return {
        code: err.code ?? 1,
        stdout: err.stdout ?? '',
        stderr: err.stderr ?? '',
        json: JSON.parse(err.stdout ?? '{}'),
      };
    }
  }

  it('holds across staging, refuses another agent, and requires exact-token release', async () => {
    writeFileSync(join(frameworkRoot, 'orgs', 'acme', 'agents', 'alice', 'MEMORY.md'), 'state');

    const staged = await run('alice', ['auto-commit']);
    expect(staged.code).toBe(0);
    expect(staged.json.status).toBe('staged');
    expect(staged.json.lease.status).toBe('held');
    expect(staged.json.lease.holder).toEqual({ org: 'acme', agent: 'alice' });
    const token = staged.json.lease.token as string;
    const leasePath = join(ctxRoot, 'state', 'auto-commit-lease.json');
    const beforeStatus = readFileSync(leasePath, 'utf-8');

    const status = await run('bob', ['auto-commit-lease-status']);
    expect(status.code).toBe(0);
    expect(status.json.status).toBe('active');
    expect(status.json.holder).toEqual({ org: 'acme', agent: 'alice' });
    expect(readFileSync(leasePath, 'utf-8')).toBe(beforeStatus);

    const contended = await run('bob', ['auto-commit']);
    expect(contended.code).toBe(1);
    expect(contended.json.error).toContain('auto-commit lease held by acme/alice until');
    expect(contended.json.error).not.toContain('existing index');

    const wrongRelease = await run('bob', ['auto-commit-release', 'wrong-token']);
    expect(wrongRelease.code).toBe(1);
    expect(wrongRelease.json.error).toContain('token does not match');
    expect(readFileSync(leasePath, 'utf-8')).toBe(beforeStatus);

    execFileSync('git', ['reset'], { cwd: frameworkRoot, stdio: 'pipe' });
    const released = await run('alice', ['auto-commit-release', token]);
    expect(released.code).toBe(0);
    expect(released.json.status).toBe('released');
    expect((await run('bob', ['auto-commit-lease-status'])).json).toEqual({ status: 'none' });
  });

  it('audits an expired-lease takeover with both owners and the prior expiry', async () => {
    const leasePath = join(ctxRoot, 'state', 'auto-commit-lease.json');
    mkdirSync(join(ctxRoot, 'state'), { recursive: true });
    writeFileSync(leasePath, JSON.stringify({
      version: 1,
      holder: { org: 'acme', agent: 'bob' },
      token: 'expired-token',
      acquired_at: 1,
      expires_at: 2,
    }));

    const result = await run('alice', ['auto-commit']);
    expect(result.code).toBe(0);
    expect(result.json.status).toBe('clean');
    expect(result.json.lease.status).toBe('released');
    expect(result.json.lease_takeover).toEqual({
      previous_holder: { org: 'acme', agent: 'bob' },
      previous_expires_at: 2,
    });

    const eventDir = join(ctxRoot, 'orgs', 'acme', 'analytics', 'events', 'alice');
    const eventFile = join(eventDir, readdirSync(eventDir).find(name => name.endsWith('.jsonl')) as string);
    const events = readFileSync(eventFile, 'utf-8').trim().split('\n').map(line => JSON.parse(line));
    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({
        event: 'auto_commit_lease_takeover',
        severity: 'warning',
        metadata: expect.objectContaining({
          previous_holder: { org: 'acme', agent: 'bob' },
          previous_expires_at: '1970-01-01T00:00:00.002Z',
          new_holder: { org: 'acme', agent: 'alice' },
          lease_disposition: 'acquired',
        }),
      }),
    ]));
  });

  it('allows exactly one winner when two fresh CLI processes acquire concurrently', async () => {
    writeFileSync(join(frameworkRoot, 'orgs', 'acme', 'agents', 'alice', 'MEMORY.md'), 'alice');
    writeFileSync(join(frameworkRoot, 'orgs', 'acme', 'agents', 'bob', 'MEMORY.md'), 'bob');

    const results = await Promise.all([
      run('alice', ['auto-commit']),
      run('bob', ['auto-commit']),
    ]);
    const winner = results.find(result => result.json.lease?.status === 'held');
    const loser = results.find(result => result.json.lease?.status === 'contended');

    expect(winner?.code).toBe(0);
    expect(winner?.json.status).toBe('staged');
    expect(loser?.code).toBe(1);
    expect(loser?.json.error).toContain('auto-commit lease held by');
    expect(results.filter(result => result.json.lease?.status === 'held')).toHaveLength(1);
    expect(results.filter(result => result.json.lease?.status === 'contended')).toHaveLength(1);

    execFileSync('git', ['reset'], { cwd: frameworkRoot, stdio: 'pipe' });
    const token = winner?.json.lease.token as string;
    const holder = winner?.json.lease.holder.agent as string;
    expect((await run(holder, ['auto-commit-release', token])).code).toBe(0);
  });

  it('refuses a 1ms override before the old mid-cycle takeover can stage anything', async () => {
    const aliceDir = join(frameworkRoot, 'orgs', 'acme', 'agents', 'alice');
    writeFileSync(join(aliceDir, 'config.json'), JSON.stringify({
      ecosystem: { local_version_control: { enabled: true, lease_ttl_ms: 1 } },
    }));
    writeFileSync(join(aliceDir, 'MEMORY.md'), 'must remain unstaged');

    const alice = await run('alice', ['auto-commit']);
    const actualIndex = execFileSync('git', ['diff', '--cached', '--name-only'], {
      cwd: frameworkRoot,
      encoding: 'utf-8',
    });

    expect(alice.code).toBe(1);
    expect(alice.json.error).toContain('between 300000 and 3600000 milliseconds');
    expect(alice.json.lease).toEqual({
      status: 'not_acquired',
      reason: 'invalid_lease_configuration',
    });
    expect(actualIndex.trim()).toBe('');
    expect(existsSync(join(ctxRoot, 'state', 'auto-commit-lease.json'))).toBe(false);
  });

  it('resets and does not commit when the pre-commit assertion is near expiry', async () => {
    const memoryPath = join(frameworkRoot, 'orgs', 'acme', 'agents', 'alice', 'MEMORY.md');
    writeFileSync(memoryPath, 'near-expiry state');
    const beforeHead = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: frameworkRoot,
      encoding: 'utf-8',
    }).trim();
    const staged = await run('alice', ['auto-commit']);
    const token = staged.json.lease.token as string;
    const leasePath = join(ctxRoot, 'state', 'auto-commit-lease.json');
    const lease = JSON.parse(readFileSync(leasePath, 'utf-8'));
    lease.expires_at = Date.now() + 59_000;
    writeFileSync(leasePath, JSON.stringify(lease));

    const assertion = await run('alice', ['auto-commit-assert-held', token]);
    if (assertion.code !== 0) {
      execFileSync('git', ['reset'], { cwd: frameworkRoot, stdio: 'pipe' });
    } else {
      execFileSync('git', ['commit', '-m', 'must not happen'], { cwd: frameworkRoot });
    }

    expect(assertion.code).toBe(1);
    expect(assertion.json.error).toContain('at least 60000ms is required before commit');
    expect(execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: frameworkRoot,
      encoding: 'utf-8',
    }).trim()).toBe(beforeHead);
    expect(execFileSync('git', ['diff', '--cached', '--name-only'], {
      cwd: frameworkRoot,
      encoding: 'utf-8',
    }).trim()).toBe('');
  });

  it('reports a successful release truthfully when telemetry fails afterward', async () => {
    writeFileSync(join(frameworkRoot, 'orgs', 'acme', 'agents', 'alice', 'MEMORY.md'), 'state');
    const staged = await run('alice', ['auto-commit']);
    const token = staged.json.lease.token as string;
    const eventsParent = join(ctxRoot, 'orgs', 'acme', 'analytics');
    mkdirSync(eventsParent, { recursive: true });
    writeFileSync(join(eventsParent, 'events'), 'not a directory');

    execFileSync('git', ['reset'], { cwd: frameworkRoot, stdio: 'pipe' });
    const released = await run('alice', ['auto-commit-release', token]);

    expect(released.code).toBe(0);
    expect(released.json.status).toBe('released');
    expect(released.json.telemetry).toEqual(expect.objectContaining({
      status: 'degraded',
      error: expect.stringContaining('release succeeded but telemetry failed'),
    }));
    expect((await run('alice', ['auto-commit-lease-status'])).json).toEqual({ status: 'none' });
    expect(existsSync(join(ctxRoot, 'state', 'auto-commit-lease.json'))).toBe(false);
  });
});
