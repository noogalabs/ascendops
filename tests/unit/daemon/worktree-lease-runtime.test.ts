import { afterEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createWorktreeLeaseRuntime } from '../../../src/daemon/worktree-lease-runtime';
import { acceptNativeMeasuredPeer } from '../../../src/daemon/peer-credentials';

const dirs: string[] = [];
afterEach(() => {
  for (const path of dirs.splice(0)) rmSync(path, { recursive: true, force: true });
});

function twoInstanceRuntime() {
  const root = mkdtempSync(join(tmpdir(), 'cortext-lease-runtime-mutator-race-'));
  dirs.push(root);
  const commonDir = join(root, 'repo.git');
  mkdirSync(commonDir, { recursive: true });
  const runnerPlatform = process.platform === 'darwin' ? 'darwin' : 'linux';
  const peer = acceptNativeMeasuredPeer({
    pid: process.pid, platform: runnerPlatform, processStartIdentity: 'fixture-kernel-token',
  });
  const options = (ctxRoot: string) => ({
    ctxRoot, repositoryCommonDir: commonDir, nativeHelperPath: '/usr/bin/true',
    readProcessIdentity: (pid: number) => ({
      kind: 'known' as const, pid, platform: runnerPlatform, kernelToken: 'fixture-kernel-token',
    }),
  });
  const firstRoot = join(root, 'instance-a');
  const secondRoot = join(root, 'instance-b');
  mkdirSync(firstRoot, { recursive: true });
  mkdirSync(secondRoot, { recursive: true });
  return {
    first: createWorktreeLeaseRuntime(options(firstRoot) as never),
    second: createWorktreeLeaseRuntime(options(secondRoot) as never),
    scopeKey: `repo:${commonDir}`,
    peer,
  };
}

async function waitForFile(path: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (!existsSync(path)) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${path}`);
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}

function waitForChild(child: ReturnType<typeof spawn>): Promise<void> {
  return new Promise((resolve, reject) => {
    let stderr = '';
    child.stderr?.on('data', chunk => { stderr += String(chunk); });
    child.once('error', reject);
    child.once('exit', code => code === 0 ? resolve() : reject(new Error(`worker exited ${code}: ${stderr}`)));
  });
}

async function runForkedBindReleaseOrder(order: 'bind-first' | 'release-first') {
  const root = mkdtempSync(join(tmpdir(), `cortext-lease-runtime-fork-${order}-`));
  dirs.push(root);
  const commonDir = join(root, 'repo.git');
  mkdirSync(commonDir, { recursive: true });
  const ctxRoot = join(root, 'seed');
  mkdirSync(ctxRoot, { recursive: true });
  const platform = process.platform === 'darwin' ? 'darwin' : 'linux';
  const identity = (pid: number) => ({
    kind: 'known' as const, pid, platform, kernelToken: `kernel:${pid}`,
  });
  const seed = createWorktreeLeaseRuntime({
    ctxRoot, repositoryCommonDir: commonDir, nativeHelperPath: '/usr/bin/true', readProcessIdentity: identity,
  });
  const scopeKey = `repo:${commonDir}`;
  const requestId = order === 'bind-first'
    ? '00000000-0000-4000-8000-000000000031'
    : '00000000-0000-4000-8000-000000000032';
  const peer = acceptNativeMeasuredPeer({
    pid: process.pid, platform, processStartIdentity: `kernel:${process.pid}`,
  });
  const grant = seed.arbiter.acquire({ scopeKey, requestId, owner: 'forked', peer });
  expect(grant.kind).toBe('granted');
  const token = grant.kind === 'granted' ? grant.token : '';
  const readyPath = join(root, 'ready');
  const goPath = join(root, 'go');
  const firstResult = join(root, 'first.json');
  const secondResult = join(root, 'second.json');
  const worker = join(process.cwd(), 'tests/helpers/pr267-v64-process-worker.ts');
  const args = (operation: string, childRoot: string, resultPath: string) => [
    '--import', 'tsx', worker, operation, commonDir, childRoot, scopeKey,
    requestId, token, String(process.pid), readyPath, goPath, resultPath,
  ];
  const firstOperation = order === 'bind-first' ? 'bind-held' : 'release-held';
  const secondOperation = order === 'bind-first' ? 'release' : 'bind';
  const first = spawn(process.execPath, args(firstOperation, join(root, 'first-root'), firstResult), {
    cwd: process.cwd(), stdio: ['ignore', 'ignore', 'pipe'],
  });
  await waitForFile(readyPath);
  const second = spawn(process.execPath, args(secondOperation, join(root, 'second-root'), secondResult), {
    cwd: process.cwd(), stdio: ['ignore', 'ignore', 'pipe'],
  });
  await waitForChild(second);
  writeFileSync(goPath, 'go\n');
  await waitForChild(first);

  return {
    first: JSON.parse(readFileSync(firstResult, 'utf8')) as { kind: string; reason?: string },
    second: JSON.parse(readFileSync(secondResult, 'utf8')) as { kind: string; reason?: string },
    persisted: seed.store.load(scopeKey),
    releasedRequest: seed.store.loadReleasedRequest(scopeKey),
    requestId,
  };
}

describe('worktree lease daemon runtime', () => {
  it('fails startup closed when persisted arbitration state is malformed', () => {
    const root = mkdtempSync(join(tmpdir(), 'cortext-lease-runtime-'));
    dirs.push(root);
    const leaseDir = join(root, 'state', '.worktree-leases');
    mkdirSync(leaseDir, { recursive: true });
    writeFileSync(join(leaseDir, 'broken.json'), '{not-json');

    expect(() => createWorktreeLeaseRuntime({
      ctxRoot: root,
      nativeHelperPath: join(root, 'missing-helper'),
    })).toThrow('lease-state-malformed');
  });

  it('finishes reconstruction before exposing the IPC service', () => {
    const root = mkdtempSync(join(tmpdir(), 'cortext-lease-runtime-'));
    dirs.push(root);
    const runtime = createWorktreeLeaseRuntime({
      ctxRoot: root,
      nativeHelperPath: join(root, 'missing-helper'),
    });
    expect(runtime.store.listPersistedScopes()).toEqual([]);
    expect(runtime.service).toBeDefined();
  });

  it('win32-admits-agent-starts-without-custody-and-refuses-destructive-reaping', async () => {
    const root = mkdtempSync(join(tmpdir(), 'cortext-lease-runtime-win32-'));
    dirs.push(root);
    const runtime = createWorktreeLeaseRuntime({
      ctxRoot: root,
      nativeHelperPath: join(root, 'unsupported-helper'),
      platform: 'win32',
      readProcessIdentity: pid => ({ kind: 'unknown', pid, reason: 'unsupported-platform-win32' }),
    });
    expect(runtime.policy).toEqual({
      custodyEnabled: false,
      reaperEnabled: false,
      reason: 'worktree-reaper-disabled-no-measured-win32-identity',
    });
    const response = await runtime.service.handle('acquire-worktree-lease', {
      scopeKey: 'repo:C:/repo',
      requestId: '00000000-0000-4000-8000-000000000099',
      owner: 'reaper',
    }, 3);
    expect(response).toMatchObject({
      success: false,
      error: 'worktree-reaper-disabled-no-measured-win32-identity',
    });
    // Daemon composition maps disabled custody to clear/true without invoking
    // the identity-dependent arbiter, preserving pre-PR agent admission.
    expect(runtime.policy.custodyEnabled ? 'blocked' : 'clear').toBe('clear');
  });

  it('two daemon instances on one repository share one lease authority', () => {
    const root = mkdtempSync(join(tmpdir(), 'cortext-lease-runtime-'));
    dirs.push(root);
    const commonDir = join(root, 'repo.git');
    mkdirSync(commonDir, { recursive: true });
    const helper = '/usr/bin/true';
    const runnerPlatform = process.platform === 'darwin' ? 'darwin' : 'linux';
    const peer = acceptNativeMeasuredPeer({
      pid: process.pid, platform: runnerPlatform, processStartIdentity: 'fixture-kernel-token',
    });
    const options = (ctxRoot: string) => ({
      ctxRoot, repositoryCommonDir: commonDir, nativeHelperPath: helper,
      readProcessIdentity: (pid: number) => ({
        kind: 'known' as const, pid, platform: runnerPlatform, kernelToken: 'fixture-kernel-token',
      }),
    });
    const firstRoot = join(root, 'instance-a');
    const secondRoot = join(root, 'instance-b');
    mkdirSync(firstRoot, { recursive: true });
    mkdirSync(secondRoot, { recursive: true });
    const first = createWorktreeLeaseRuntime(options(firstRoot) as never);
    expect(first.arbiter.acquire({
      scopeKey: `repo:${commonDir}`, requestId: '00000000-0000-4000-8000-000000000001', owner: 'a', peer,
    }).kind).toBe('granted');
    const second = createWorktreeLeaseRuntime(options(secondRoot) as never);
    expect(second.arbiter.acquire({
      scopeKey: `repo:${commonDir}`, requestId: '00000000-0000-4000-8000-000000000002', owner: 'b', peer,
    }).kind).toBe('refused');
  });

  it('interprocess-scope-lock-makes-an-absent-scope-race-grant-exactly-once', () => {
    const root = mkdtempSync(join(tmpdir(), 'cortext-lease-runtime-race-'));
    dirs.push(root);
    const commonDir = join(root, 'repo.git');
    mkdirSync(commonDir, { recursive: true });
    const runnerPlatform = process.platform === 'darwin' ? 'darwin' : 'linux';
    const peer = acceptNativeMeasuredPeer({
      pid: process.pid, platform: runnerPlatform, processStartIdentity: 'fixture-kernel-token',
    });
    const options = (ctxRoot: string) => ({
      ctxRoot, repositoryCommonDir: commonDir, nativeHelperPath: '/usr/bin/true',
      readProcessIdentity: (pid: number) => ({
        kind: 'known' as const, pid, platform: runnerPlatform, kernelToken: 'fixture-kernel-token',
      }),
    });
    const first = createWorktreeLeaseRuntime(options(join(root, 'instance-a')) as never);
    const second = createWorktreeLeaseRuntime(options(join(root, 'instance-b')) as never);
    const scopeKey = `repo:${commonDir}`;
    const secondAcquire = vi.fn(() => second.arbiter.acquire({
      scopeKey, requestId: '00000000-0000-4000-8000-000000000012', owner: 'b', peer,
    }));
    const firstPublish = first.store.publish.bind(first.store);
    vi.spyOn(first.store, 'publish').mockImplementation(record => {
      // Enter the second production arbiter after both runtimes observed absent,
      // but before the first publication. Only a common-dir interprocess lock
      // spanning observe -> decide -> publish can make this conditional.
      secondAcquire();
      firstPublish(record);
    });

    const firstResult = first.arbiter.acquire({
      scopeKey, requestId: '00000000-0000-4000-8000-000000000011', owner: 'a', peer,
    });
    expect(firstResult.kind).toBe('granted');
    expect(secondAcquire).toHaveBeenCalledOnce();
    expect(secondAcquire.mock.results[0].value.kind).toBe('refused');
  });

  it('scope-lock-serializes-bind-before-release-without-acknowledging-a-live-child-release', () => {
    const { first, second, scopeKey, peer } = twoInstanceRuntime();
    const requestId = '00000000-0000-4000-8000-000000000021';
    const grant = first.arbiter.acquire({ scopeKey, requestId, owner: 'a', peer });
    expect(grant.kind).toBe('granted');
    const token = grant.kind === 'granted' ? grant.token : '';
    const nestedRelease = vi.fn(() => second.arbiter.release(scopeKey, requestId, token));
    const publish = first.store.publish.bind(first.store);
    vi.spyOn(first.store, 'publish').mockImplementation(record => {
      if (record.destructiveChild) nestedRelease();
      publish(record);
    });

    expect(first.arbiter.bindDestructiveChild(scopeKey, requestId, token, peer, {
      pid: process.pid, platform: peer.platform, processStartIdentity: peer.processStartIdentity,
    })).toEqual({ kind: 'bound' });
    expect(nestedRelease).toHaveBeenCalledOnce();
    expect(nestedRelease.mock.results[0].value).toEqual({ kind: 'refused', reason: 'UNKNOWN' });
    expect(second.arbiter.release(scopeKey, requestId, token)).toEqual({ kind: 'refused', reason: 'UNKNOWN' });
  });

  it('scope-lock-serializes-release-before-bind-without-resurrecting-a-released-lease', () => {
    const { first, second, scopeKey, peer } = twoInstanceRuntime();
    const requestId = '00000000-0000-4000-8000-000000000022';
    const grant = first.arbiter.acquire({ scopeKey, requestId, owner: 'a', peer });
    expect(grant.kind).toBe('granted');
    const token = grant.kind === 'granted' ? grant.token : '';
    const nestedBind = vi.fn(() => second.arbiter.bindDestructiveChild(scopeKey, requestId, token, peer, {
      pid: process.pid, platform: peer.platform, processStartIdentity: peer.processStartIdentity,
    }));
    const remove = first.store.remove.bind(first.store);
    vi.spyOn(first.store, 'remove').mockImplementation(record => {
      nestedBind();
      remove(record);
    });

    expect(first.arbiter.release(scopeKey, requestId, token)).toEqual({ kind: 'released', alreadyAbsent: false });
    expect(nestedBind).toHaveBeenCalledOnce();
    expect(nestedBind.mock.results[0].value).toEqual({ kind: 'refused', reason: 'UNKNOWN' });
    expect(second.store.load(scopeKey)).toBeUndefined();
    expect(second.store.loadReleasedRequest(scopeKey)).toBe(requestId);
  });

  it('scope-lock-serializes-bind-vs-bind-mutators', () => {
    const { first, second, scopeKey, peer } = twoInstanceRuntime();
    const requestId = '00000000-0000-4000-8000-000000000023';
    const grant = first.arbiter.acquire({ scopeKey, requestId, owner: 'a', peer });
    expect(grant.kind).toBe('granted');
    const token = grant.kind === 'granted' ? grant.token : '';
    const secondBind = vi.fn(() => second.arbiter.bindDestructiveChild(scopeKey, requestId, token, peer, {
      pid: process.pid, platform: peer.platform, processStartIdentity: peer.processStartIdentity,
    }));
    const publish = first.store.publish.bind(first.store);
    vi.spyOn(first.store, 'publish').mockImplementation(record => {
      if (record.destructiveChild) secondBind();
      publish(record);
    });
    expect(first.arbiter.bindDestructiveChild(scopeKey, requestId, token, peer, {
      pid: process.pid, platform: peer.platform, processStartIdentity: peer.processStartIdentity,
    })).toEqual({ kind: 'bound' });
    expect(secondBind.mock.results[0].value).toEqual({ kind: 'refused', reason: 'UNKNOWN' });
  });

  it('scope-lock-serializes-release-vs-release-mutators', () => {
    const { first, second, scopeKey, peer } = twoInstanceRuntime();
    const requestId = '00000000-0000-4000-8000-000000000024';
    const grant = first.arbiter.acquire({ scopeKey, requestId, owner: 'a', peer });
    expect(grant.kind).toBe('granted');
    const token = grant.kind === 'granted' ? grant.token : '';
    const secondRelease = vi.fn(() => second.arbiter.release(scopeKey, requestId, token));
    const remove = first.store.remove.bind(first.store);
    vi.spyOn(first.store, 'remove').mockImplementation(record => {
      secondRelease();
      remove(record);
    });
    expect(first.arbiter.release(scopeKey, requestId, token)).toEqual({ kind: 'released', alreadyAbsent: false });
    expect(secondRelease.mock.results[0].value).toEqual({ kind: 'refused', reason: 'UNKNOWN' });
    expect(second.arbiter.release(scopeKey, requestId, token)).toEqual({ kind: 'released', alreadyAbsent: true });
  });

  it('post-lock-reread-not-a-pre-lock-cache-authorizes-child-binding', () => {
    const { first, second, scopeKey, peer } = twoInstanceRuntime();
    const requestId = '00000000-0000-4000-8000-000000000025';
    // Seed an explicit process-local absent hypothesis. The durable grant is
    // published afterward by the other runtime; bind must discard that cache.
    expect(second.arbiter.state(scopeKey)).toEqual({ kind: 'absent' });
    const grant = first.arbiter.acquire({ scopeKey, requestId, owner: 'a', peer });
    expect(grant.kind).toBe('granted');
    const token = grant.kind === 'granted' ? grant.token : '';
    expect(second.arbiter.bindDestructiveChild(scopeKey, requestId, token, peer, {
      pid: process.pid, platform: peer.platform, processStartIdentity: peer.processStartIdentity,
    })).toEqual({ kind: 'bound' });
  });

  it('post-lock-reread-not-a-pre-lock-cache-authorizes-capability-release', () => {
    const { first, second, scopeKey, peer } = twoInstanceRuntime();
    const requestId = '00000000-0000-4000-8000-000000000026';
    expect(second.arbiter.state(scopeKey)).toEqual({ kind: 'absent' });
    const grant = first.arbiter.acquire({ scopeKey, requestId, owner: 'a', peer });
    expect(grant.kind).toBe('granted');
    const token = grant.kind === 'granted' ? grant.token : '';
    expect(second.arbiter.release(scopeKey, requestId, token)).toEqual({
      kind: 'released', alreadyAbsent: false,
    });
  });

  it('post-lock-reread-never-publishes-a-child-from-a-pre-release-observation', () => {
    const { first, second, scopeKey, peer } = twoInstanceRuntime();
    const requestId = '00000000-0000-4000-8000-000000000027';
    const grant = first.arbiter.acquire({ scopeKey, requestId, owner: 'a', peer });
    expect(grant.kind).toBe('granted');
    const token = grant.kind === 'granted' ? grant.token : '';
    expect(second.arbiter.reconstruct(scopeKey).kind).toBe('live-held');
    expect(first.arbiter.release(scopeKey, requestId, token)).toEqual({
      kind: 'released', alreadyAbsent: false,
    });
    expect(second.arbiter.bindDestructiveChild(scopeKey, requestId, token, peer, {
      pid: process.pid, platform: peer.platform, processStartIdentity: peer.processStartIdentity,
    })).toEqual({ kind: 'refused', reason: 'CAPABILITY_MISMATCH' });
    expect(second.store.load(scopeKey)).toBeUndefined();
    expect(second.store.loadReleasedRequest(scopeKey)).toBe(requestId);
  });

  it('forked-processes-serialize-bind-before-release-on-the-real-common-dir-lock', async () => {
    const result = await runForkedBindReleaseOrder('bind-first');
    expect(result.first).toEqual({ kind: 'bound' });
    expect(result.second).toEqual({ kind: 'refused', reason: 'UNKNOWN' });
    expect(result.persisted?.destructiveChild?.pid).toBe(process.pid);
    expect(result.releasedRequest).toBeUndefined();
  }, 20_000);

  it('forked-processes-serialize-release-before-bind-without-resurrection', async () => {
    const result = await runForkedBindReleaseOrder('release-first');
    expect(result.first).toEqual({ kind: 'released', alreadyAbsent: false });
    expect(result.second).toEqual({ kind: 'refused', reason: 'UNKNOWN' });
    expect(result.persisted).toBeUndefined();
    expect(result.releasedRequest).toBe(result.requestId);
  }, 20_000);
});
