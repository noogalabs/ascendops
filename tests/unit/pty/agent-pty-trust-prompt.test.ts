// Trust-prompt auto-accept timer lifecycle.
//
// AgentPTY.spawn() arms a bounded timer schedule that auto-accepts Claude Code's
// "trust this folder?" prompt by writing Enter. These tests lock in:
//   1. The happy path still fires Enter when the trust prompt is visible.
//   2. kill() cancels the timers — a stray Enter must NOT be written into a
//      RESPAWNED PTY on the same instance (the callbacks only check
//      `this.pty`, which is truthy again after a respawn).
//   3. PTY exit cancels the timers the same way.
//   4. HermesPTY opts out entirely (no trust prompt in Hermes).

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Hermetic fs: skip secrets.env / agent .env loading.
vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs');
  return {
    ...actual,
    existsSync: vi.fn().mockReturnValue(false),
    writeFileSync: vi.fn(),
    unlinkSync: vi.fn(),
  };
});

const { AgentPTY } = await import('../../../src/pty/agent-pty.js');
const { HermesPTY } = await import('../../../src/pty/hermes-pty.js');

import type { CtxEnv } from '../../../src/types/index';

const TEST_ENV: CtxEnv = {
  instanceId: 'test',
  ctxRoot: '/tmp/ctx',
  frameworkRoot: '/tmp/fw',
  agentName: 'test-agent',
  org: 'test-org',
  agentDir: '/tmp/fw/orgs/test-org/agents/test-agent',
  projectRoot: '/tmp/fw',
};

type ExitCb = (e: { exitCode: number; signal?: number }) => void;

function makeFakePty() {
  let exitCb: ExitCb | null = null;
  let dataCb: ((data: string) => void) | null = null;
  const fake = {
    pid: 4242,
    write: vi.fn(),
    onData: vi.fn((cb: (data: string) => void) => { dataCb = cb; return { dispose: () => undefined }; }),
    onExit: vi.fn((cb: ExitCb) => { exitCb = cb; return { dispose: () => undefined }; }),
    kill: vi.fn(),
    resize: vi.fn(),
  };
  return {
    fake,
    emitData: (d: string) => dataCb?.(d),
    emitExit: (code: number) => exitCb?.({ exitCode: code, signal: 0 }),
  };
}

function newAgentPty(handle: ReturnType<typeof makeFakePty>) {
  const pty = new AgentPTY(TEST_ENV, { vendor: 'anthropic' });
  // Inject the spawn mock onto the private field — bypasses the lazy
  // require('node-pty') (same pattern as tests/integration/pty/vendor-flip).
  (pty as unknown as { spawnFn: unknown }).spawnFn = vi.fn(() => handle.fake);
  return pty;
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('AgentPTY trust-prompt auto-accept', () => {
  it('rejects a whitespace-only configured working directory', async () => {
    const handle = makeFakePty();
    const pty = new AgentPTY(TEST_ENV, { vendor: 'anthropic', working_directory: '   ' });
    (pty as unknown as { spawnFn: unknown }).spawnFn = vi.fn(() => handle.fake);
    await expect(pty.spawn('fresh', 'hello')).rejects.toThrow(/whitespace-only/);
  });

  it('rejects a missing configured working directory', async () => {
    const handle = makeFakePty();
    const pty = new AgentPTY(TEST_ENV, { vendor: 'anthropic', working_directory: '/definitely/missing' });
    (pty as unknown as { spawnFn: unknown }).spawnFn = vi.fn(() => handle.fake);
    await expect(pty.spawn('fresh', 'hello')).rejects.toThrow(/does not exist/);
  });

  it('navigates Down+Enter for the Bypass Permissions prompt', async () => {
    const handle = makeFakePty();
    const pty = newAgentPty(handle);
    await pty.spawn('fresh', 'hello');

    handle.emitData('Bypass Permissions\n  1. No, exit\n  2. Yes, I accept\n');
    vi.advanceTimersByTime(5000);

    expect(handle.fake.write).toHaveBeenCalledTimes(1);
    expect(handle.fake.write).toHaveBeenCalledWith('\x1b[B\r');
    expect(handle.fake.write).not.toHaveBeenCalledWith('\r');
  });

  it('answers a visible Bypass Permissions prompt repeatedly but caps answers at three', async () => {
    const handle = makeFakePty();
    const pty = newAgentPty(handle);
    await pty.spawn('fresh', 'hello');

    handle.emitData('Bypass Permissions\n  1. No, exit\n  2. Yes, I accept\n');
    vi.advanceTimersByTime(8000);

    expect(handle.fake.write.mock.calls.map((call) => call[0])).toEqual([
      '\x1b[B\r',
      '\x1b[B\r',
    ]);

    vi.advanceTimersByTime(24000);

    expect(handle.fake.write.mock.calls.map((call) => call[0])).toEqual([
      '\x1b[B\r',
      '\x1b[B\r',
      '\x1b[B\r',
    ]);
    expect(handle.fake.write.mock.calls.map((call) => call[0])).not.toContain('\r');
  });

  it('stops answering when the bypass dialog leaves the recent tail', async () => {
    const handle = makeFakePty();
    const pty = newAgentPty(handle);
    await pty.spawn('fresh', 'hello');

    handle.emitData('Bypass Permissions\n  1. No, exit\n  2. Yes, I accept\n');
    vi.advanceTimersByTime(5000);
    handle.emitData('x'.repeat(5000));
    vi.advanceTimersByTime(27000);

    expect(handle.fake.write.mock.calls.map((call) => call[0])).toEqual(['\x1b[B\r']);
  });

  it('strips ANSI before classifying a Bypass Permissions prompt', async () => {
    const handle = makeFakePty();
    const pty = newAgentPty(handle);
    await pty.spawn('fresh', 'hello');

    handle.emitData('Byp\x1b[1mass\x1b[0m Permissions\n  1. No, exit\n  2. Yes, I accept\n');
    vi.advanceTimersByTime(5000);

    expect(handle.fake.write).toHaveBeenCalledWith('\x1b[B\r');
    expect(handle.fake.write).not.toHaveBeenCalledWith('\r');
  });

  it('never sends bare Enter when a reworded bypass gate still shows No, exit', async () => {
    const handle = makeFakePty();
    const pty = newAgentPty(handle);
    await pty.spawn('fresh', 'hello');

    handle.emitData('bypass permissions v2 reworded\n  1. No, exit\n  2. Yes, I accept\n');
    vi.advanceTimersByTime(5000);

    expect(handle.fake.write).toHaveBeenCalledWith('\x1b[B\r');
    expect(handle.fake.write).not.toHaveBeenCalledWith('\r');
  });

  it('does not answer bypass text that has left the final 4KB tail', async () => {
    const handle = makeFakePty();
    const pty = newAgentPty(handle);
    await pty.spawn('fresh', 'hello');

    handle.emitData('Bypass Permissions\n  1. No, exit\n  2. Yes, I accept\n');
    handle.emitData('x'.repeat(5000));
    vi.advanceTimersByTime(32000);

    expect(handle.fake.write).not.toHaveBeenCalled();
  });

  it('answers a bypass dialog that renders after the original 14-second window', async () => {
    const handle = makeFakePty();
    const pty = newAgentPty(handle);
    await pty.spawn('fresh', 'hello');

    vi.advanceTimersByTime(16000);
    handle.emitData('Bypass Permissions\n  1. No, exit\n  2. Yes, I accept\n');
    vi.advanceTimersByTime(4000);

    expect(handle.fake.write).toHaveBeenCalledWith('\x1b[B\r');
    expect(handle.fake.write).not.toHaveBeenCalledWith('\r');
  });

  it('never types after bootstrap when old bypass tokens remain in the tail', async () => {
    const handle = makeFakePty();
    const pty = newAgentPty(handle);
    await pty.spawn('fresh', 'hello');

    handle.emitData('Bypass Permissions\n  1. No, exit\n  2. Yes, I accept\n');
    handle.emitData('accept edits · permissions');
    expect(pty.getOutputBuffer().isBootstrapped()).toBe(true);

    vi.advanceTimersByTime(32_000);

    expect(handle.fake.write).not.toHaveBeenCalled();
  });

  it('never types when prompt-like ordinary text arrives after bootstrap', async () => {
    const handle = makeFakePty();
    const pty = newAgentPty(handle);
    await pty.spawn('fresh', 'hello');

    handle.emitData('accept edits · permissions');
    expect(pty.getOutputBuffer().isBootstrapped()).toBe(true);
    handle.emitData('documentation: Do you trust this folder? Yes, continue.\n');

    vi.advanceTimersByTime(32_000);

    expect(handle.fake.write).not.toHaveBeenCalled();
    expect(pty.getOutputBuffer().isBootstrapped()).toBe(true);
  });

  it('does not type on unpaired trust or yes words in ordinary output', async () => {
    const handle = makeFakePty();
    const pty = newAgentPty(handle);
    await pty.spawn('fresh', 'hello');

    handle.emitData('Yes — model loaded. trust region configured.\n');
    vi.advanceTimersByTime(32_000);

    expect(handle.fake.write).not.toHaveBeenCalled();
  });

  it('fires Enter at 5s when the trust prompt is visible', async () => {
    const handle = makeFakePty();
    const pty = newAgentPty(handle);
    await pty.spawn('fresh', 'hello');

    handle.emitData('Do you trust the files in this folder?\n  Yes, proceed\n');
    vi.advanceTimersByTime(5000);

    expect(handle.fake.write).not.toHaveBeenCalledWith('\x1b[B\r');
    expect(handle.fake.write).toHaveBeenCalledWith('\r');
  });

  it('does NOT fire after kill() — timers are cancelled, respawn is protected', async () => {
    const handle = makeFakePty();
    const pty = newAgentPty(handle);
    await pty.spawn('fresh', 'hello'); // t=0: timers armed for t=5s, t=8s
    handle.emitData('Do you trust the files in this folder?\n  Yes, proceed\n');

    // Kill at t=3s — BEFORE the first trust timer fires — then respawn on
    // the same instance. The respawn arms its own timers for t=8s/t=11s.
    vi.advanceTimersByTime(3000);
    pty.kill();
    handle.emitExit(0);
    const handle2 = makeFakePty();
    (pty as unknown as { spawnFn: unknown }).spawnFn = vi.fn(() => handle2.fake);
    await pty.spawn('fresh', 'hello again');

    // Advance to t=7s: the STALE first-spawn timers (t=5s) would have fired
    // by now; the respawn's own timers (t=8s) have not. Any write here can
    // only come from a stale timer hitting the respawned PTY.
    vi.advanceTimersByTime(4000);

    expect(handle.fake.write).not.toHaveBeenCalled();
    expect(handle2.fake.write).not.toHaveBeenCalled();
  });

  it('does NOT fire after the PTY exits on its own', async () => {
    const handle = makeFakePty();
    const pty = newAgentPty(handle);
    await pty.spawn('fresh', 'hello');
    handle.emitData('trust this folder? Yes\n');

    handle.emitExit(1); // crash before the 5s timer
    vi.advanceTimersByTime(8000);

    expect(handle.fake.write).not.toHaveBeenCalled();
  });

  it('HermesPTY never arms trust-prompt timers (no trust prompt in Hermes)', async () => {
    const handle = makeFakePty();
    const pty = new HermesPTY(TEST_ENV, {});
    (pty as unknown as { spawnFn: unknown }).spawnFn = vi.fn(() => handle.fake);
    await pty.spawn('fresh', 'hello');

    // Output that the loose substring match would treat as a trust prompt.
    handle.emitData('Yes — model loaded. trust region configured.\n');
    vi.advanceTimersByTime(8000);

    // No auto-accept Enter. (The startup injection runs on its own async
    // loop gated by the "❯" bootstrap pattern, which never appeared.)
    const writes = handle.fake.write.mock.calls.map((c) => c[0]);
    expect(writes).not.toContain('\r');
  });

  it('surfaces a first-run prompt that remains wedged at the backstop', async () => {
    const handle = makeFakePty();
    const pty = newAgentPty(handle);
    await pty.spawn('fresh', 'hello');
    handle.emitData('Bypass Permissions\n  1. No, exit\n  2. Yes, I accept\n');
    await vi.advanceTimersByTimeAsync(45_000);
    expect(pty.isAwaitingInteractiveConfirmation()).toBe(true);
  });

  it('does not mistake a lowercase bypass dialog for the permissions status bar', async () => {
    const handle = makeFakePty();
    const pty = newAgentPty(handle);
    await pty.spawn('fresh', 'hello');
    handle.emitData('bypass permissions\n  1. No, exit\n  2. Yes, I accept\n');
    expect(pty.getOutputBuffer().isBootstrapped()).toBe(false);
    await vi.advanceTimersByTimeAsync(45_000);
    expect(pty.isAwaitingInteractiveConfirmation()).toBe(true);
  });

  it('does not report a wedge after late bootstrap', async () => {
    const handle = makeFakePty();
    const pty = newAgentPty(handle);
    await pty.spawn('fresh', 'hello');
    handle.emitData('Bypass Permissions\n  1. No, exit\n  2. Yes, I accept\n');
    await vi.advanceTimersByTimeAsync(45_000);
    expect(pty.isAwaitingInteractiveConfirmation()).toBe(true);
    handle.emitData('accept edits · permissions');
    expect(pty.isAwaitingInteractiveConfirmation()).toBe(false);
  });
});
