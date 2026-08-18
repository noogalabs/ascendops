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

const preflightMocks = vi.hoisted(() => ({
  ensureFolderTrusted: vi.fn(() => true),
  ensureBypassPromptSuppressed: vi.fn(() => true),
  readUnattendedConsent: vi.fn<() => boolean | undefined>(() => undefined),
}));

vi.mock('../../../src/utils/claude-preflight.js', () => preflightMocks);

const { AgentPTY } = await import('../../../src/pty/agent-pty.js');
const { HermesPTY } = await import('../../../src/pty/hermes-pty.js');

import type { AgentConfig, CtxEnv } from '../../../src/types/index';

const TEST_ENV: CtxEnv = {
  instanceId: 'test',
  ctxRoot: '/tmp/ctx',
  frameworkRoot: '/tmp/fw',
  agentName: 'test-agent',
  org: 'test-org',
  agentDir: '/tmp/fw/orgs/test-org/agents/test-agent',
  projectRoot: '/tmp/fw',
};

const REAL_BYPASS_DIALOG =
  'Claude Code is running in Bypass Permissions mode.\n' +
  'This mode allows potentially DANGEROUS commands.\n' +
  '  1. No, exit\n' +
  '  2. Yes, I accept\n';
const REAL_FOLDER_TRUST_DIALOG =
  'Quick safety check: Is this a project you created or one you trust?\n' +
  '  > 1. Yes, I trust this folder\n' +
  '    2. No, exit\n';
const REAL_FOLDER_TRUST_PERMISSIONS_DIALOG =
  'Quick safety check: Is this a project you created or one you trust?\n' +
  '  > 1. Yes, I trust this folder\n' +
  '    2. No, continue without these permissions\n';
const FAKE_JWT =
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJ0ZXN0LXNlc3Npb24taWQifQ.abcdefghij_-abcdefghij';

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

function newAgentPty(
  handle: ReturnType<typeof makeFakePty>,
  config: AgentConfig = { vendor: 'anthropic' },
) {
  const pty = new AgentPTY(TEST_ENV, config);
  // Inject the spawn mock onto the private field — bypasses the lazy
  // require('node-pty') (same pattern as tests/integration/pty/vendor-flip).
  (pty as unknown as { spawnFn: unknown }).spawnFn = vi.fn(() => handle.fake);
  return pty;
}

function detectorStateWithoutOutputBuffer(pty: InstanceType<typeof AgentPTY>): string {
  const fields = { ...(pty as unknown as Record<string, unknown>) };
  delete fields.outputBuffer;
  return JSON.stringify(fields);
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  preflightMocks.ensureFolderTrusted.mockReturnValue(true);
  preflightMocks.ensureBypassPromptSuppressed.mockReturnValue(true);
  preflightMocks.readUnattendedConsent.mockReset().mockReturnValue(undefined);
});

afterEach(() => {
  vi.useRealTimers();
});

describe('AgentPTY trust-prompt auto-accept', () => {
  it('re-repairs before a second spawn on the same object with its retained function', async () => {
    const handle = makeFakePty();
    const pty = new AgentPTY(TEST_ENV, { vendor: 'anthropic' });
    let helperExecutable = false;
    const retainedSpawn = vi.fn(() => {
      if (!helperExecutable) throw new Error('posix_spawnp failed');
      return handle.fake;
    });
    const prepareSpawn = vi.fn((cached: typeof retainedSpawn | null) => {
      helperExecutable = true;
      return cached ?? retainedSpawn;
    });
    const internals = pty as unknown as {
      spawnFn: typeof retainedSpawn | null;
      prepareSpawnFn: typeof prepareSpawn;
    };
    internals.spawnFn = null;
    internals.prepareSpawnFn = prepareSpawn;

    await pty.spawn('fresh', 'first');
    pty.kill();
    helperExecutable = false;
    await pty.spawn('fresh', 'second');

    expect(prepareSpawn).toHaveBeenNthCalledWith(1, null);
    expect(prepareSpawn).toHaveBeenNthCalledWith(2, retainedSpawn);
    expect(retainedSpawn).toHaveBeenCalledTimes(2);
    expect(internals.spawnFn).toBe(retainedSpawn);
    expect(helperExecutable).toBe(true);
    pty.kill();
  });

  it.each([
    { label: 'declined record', record: false, config: {}, flag: false, bypassWrite: false },
    { label: 'accepted record', record: true, config: {}, flag: true, bypassWrite: true },
    { label: 'no record back-compat', record: undefined, config: {}, flag: true, bypassWrite: true },
    { label: 'explicit false beats accepted record', record: true, config: { dangerously_skip_permissions: false }, flag: false, bypassWrite: false },
    { label: 'explicit true beats declined record', record: false, config: { dangerously_skip_permissions: true }, flag: true, bypassWrite: true },
  ])('$label controls adapter, preflight, and bypass matcher together', async ({ record, config, flag, bypassWrite }) => {
    preflightMocks.readUnattendedConsent.mockReturnValue(record);
    const handle = makeFakePty();
    const pty = new AgentPTY(TEST_ENV, { vendor: 'anthropic', ...config });
    const spawnFn = vi.fn(() => handle.fake);
    (pty as unknown as { spawnFn: unknown }).spawnFn = spawnFn;

    await pty.spawn('fresh', 'hello');
    const args = spawnFn.mock.calls[0][1] as string[];
    expect(args.includes('--dangerously-skip-permissions')).toBe(flag);
    if (flag) {
      expect(preflightMocks.ensureBypassPromptSuppressed).toHaveBeenCalledTimes(1);
    } else {
      expect(preflightMocks.ensureBypassPromptSuppressed).not.toHaveBeenCalled();
    }

    handle.emitData(REAL_BYPASS_DIALOG);
    vi.advanceTimersByTime(5000);
    expect(handle.fake.write.mock.calls.some((call) => call[0] === '\x1b[B\r')).toBe(bypassWrite);
  });

  it('re-resolves accepted consent as fail-closed on the next spawn of the same instance', async () => {
    preflightMocks.readUnattendedConsent.mockReturnValue(true);
    const first = makeFakePty();
    const pty = newAgentPty(first);
    const firstSpawn = vi.fn(() => first.fake);
    (pty as unknown as { spawnFn: unknown }).spawnFn = firstSpawn;

    await pty.spawn('fresh', 'first');
    expect((firstSpawn.mock.calls[0][1] as string[])).toContain('--dangerously-skip-permissions');
    first.emitExit(0);

    vi.clearAllMocks();
    preflightMocks.readUnattendedConsent.mockReturnValue(false);
    const second = makeFakePty();
    const secondSpawn = vi.fn(() => second.fake);
    (pty as unknown as { spawnFn: unknown }).spawnFn = secondSpawn;
    await pty.spawn('fresh', 'second');
    second.emitData(REAL_BYPASS_DIALOG);
    vi.advanceTimersByTime(32000);

    expect((secondSpawn.mock.calls[0][1] as string[])).not.toContain('--dangerously-skip-permissions');
    expect(preflightMocks.ensureBypassPromptSuppressed).not.toHaveBeenCalled();
    expect(second.fake.write).not.toHaveBeenCalledWith('\x1b[B\r');
    expect(preflightMocks.readUnattendedConsent).toHaveBeenCalledTimes(1);
  });

  it('re-resolves declined consent as accepted on the next spawn of the same instance', async () => {
    preflightMocks.readUnattendedConsent.mockReturnValue(false);
    const first = makeFakePty();
    const pty = newAgentPty(first);
    const firstSpawn = vi.fn(() => first.fake);
    (pty as unknown as { spawnFn: unknown }).spawnFn = firstSpawn;

    await pty.spawn('fresh', 'first');
    expect((firstSpawn.mock.calls[0][1] as string[])).not.toContain('--dangerously-skip-permissions');
    first.emitExit(0);

    preflightMocks.readUnattendedConsent.mockReturnValue(true);
    const second = makeFakePty();
    const secondSpawn = vi.fn(() => second.fake);
    (pty as unknown as { spawnFn: unknown }).spawnFn = secondSpawn;
    await pty.spawn('fresh', 'second');

    expect((secondSpawn.mock.calls[0][1] as string[])).toContain('--dangerously-skip-permissions');
    expect(preflightMocks.readUnattendedConsent).toHaveBeenCalledTimes(2);
  });

  it.each([true, false])('keeps explicit %s sticky without reading consent across respawns', async (explicit) => {
    preflightMocks.readUnattendedConsent.mockReturnValue(!explicit);
    const first = makeFakePty();
    const pty = newAgentPty(first, { vendor: 'anthropic', dangerously_skip_permissions: explicit });
    const firstSpawn = vi.fn(() => first.fake);
    (pty as unknown as { spawnFn: unknown }).spawnFn = firstSpawn;

    await pty.spawn('fresh', 'first');
    first.emitExit(0);

    const second = makeFakePty();
    const secondSpawn = vi.fn(() => second.fake);
    (pty as unknown as { spawnFn: unknown }).spawnFn = secondSpawn;
    await pty.spawn('fresh', 'second');

    expect((firstSpawn.mock.calls[0][1] as string[]).includes('--dangerously-skip-permissions')).toBe(explicit);
    expect((secondSpawn.mock.calls[0][1] as string[]).includes('--dangerously-skip-permissions')).toBe(explicit);
    expect(preflightMocks.readUnattendedConsent).not.toHaveBeenCalled();
  });

  it('runs both Claude preflight controls before spawning the default unattended process', async () => {
    const handle = makeFakePty();
    const pty = newAgentPty(handle);
    const spawnFn = vi.fn(() => {
      expect(preflightMocks.ensureFolderTrusted).toHaveBeenCalledWith(TEST_ENV.agentDir);
      expect(preflightMocks.ensureBypassPromptSuppressed).toHaveBeenCalledTimes(1);
      return handle.fake;
    });
    (pty as unknown as { spawnFn: unknown }).spawnFn = spawnFn;

    await pty.spawn('fresh', 'hello');

    expect(spawnFn).toHaveBeenCalledTimes(1);
  });

  it('still pre-trusts the folder but skips bypass suppression when unattended mode is disabled', async () => {
    const handle = makeFakePty();
    const pty = newAgentPty(handle, {
      vendor: 'anthropic',
      dangerously_skip_permissions: false,
    });

    await pty.spawn('fresh', 'hello');

    expect(preflightMocks.ensureFolderTrusted).toHaveBeenCalledWith(TEST_ENV.agentDir);
    expect(preflightMocks.ensureBypassPromptSuppressed).not.toHaveBeenCalled();
  });

  it('continues to spawn if both preflight calls unexpectedly throw', async () => {
    const handle = makeFakePty();
    const pty = newAgentPty(handle);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    preflightMocks.ensureFolderTrusted.mockImplementationOnce(() => { throw new Error('trust write failed'); });
    preflightMocks.ensureBypassPromptSuppressed.mockImplementationOnce(() => { throw new Error('settings write failed'); });

    await expect(pty.spawn('fresh', 'hello')).resolves.toBeUndefined();

    expect(handle.fake.onData).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledTimes(2);
    warn.mockRestore();
  });

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

    handle.emitData(REAL_BYPASS_DIALOG);
    vi.advanceTimersByTime(5000);

    expect(handle.fake.write).toHaveBeenCalledTimes(1);
    expect(handle.fake.write).toHaveBeenCalledWith('\x1b[B\r');
    expect(handle.fake.write).not.toHaveBeenCalledWith('\r');
  });

  it('does not retry an accepted bypass prompt without new bypass evidence', async () => {
    const handle = makeFakePty();
    const pty = newAgentPty(handle);
    await pty.spawn('fresh', 'hello');

    handle.emitData('Bypass Permissions\n  1. No, exit\n  2. Yes, I accept\n');
    vi.advanceTimersByTime(5000);
    handle.emitData('Session restored. Ready for input.\n');
    vi.advanceTimersByTime(27000);

    expect(handle.fake.write.mock.calls.map((call) => call[0])).toEqual(['\x1b[B\r']);
  });

  it('uses bare Enter when folder trust follows an accepted bypass prompt', async () => {
    const handle = makeFakePty();
    const pty = newAgentPty(handle);
    await pty.spawn('fresh', 'hello');

    handle.emitData('Bypass Permissions\n  1. No, exit\n  2. Yes, I accept\n');
    vi.advanceTimersByTime(5000);
    handle.emitData(REAL_FOLDER_TRUST_DIALOG);
    vi.advanceTimersByTime(3000);

    expect(handle.fake.write.mock.calls.map((call) => call[0])).toEqual([
      '\x1b[B\r',
      '\r',
    ]);
  });

  it('retries only when new output proves the bypass dialog is still current', async () => {
    const handle = makeFakePty();
    const pty = newAgentPty(handle);
    await pty.spawn('fresh', 'hello');

    handle.emitData('Bypass Permissions\n  1. No, exit\n  2. Yes, I accept\n');
    vi.advanceTimersByTime(5000);
    handle.emitData('Bypass Permissions\n  1. No, exit\n  2. Yes, I accept\n');
    vi.advanceTimersByTime(3000);

    expect(handle.fake.write.mock.calls.map((call) => call[0])).toEqual([
      '\x1b[B\r',
      '\x1b[B\r',
    ]);
  });

  it.each([
    ['complete JWT', [`token=${FAKE_JWT}\n`], FAKE_JWT],
    ['chunk-split JWT', [`token=${FAKE_JWT.slice(0, 40)}`, `${FAKE_JWT.slice(40)}\n`], FAKE_JWT],
    ['chunk-split SSN', ['SSN: 987-65-', '4321\n'], '987-65-4321'],
    ['chunk-split bank account', ['bank account 123456', '789012\n'], '123456789012'],
  ])('never copies %s into prompt detector state or retains it after exit', async (_name, chunks, secret) => {
    const handle = makeFakePty();
    const pty = newAgentPty(handle);
    await pty.spawn('fresh', 'hello');

    for (const chunk of chunks) {
      handle.emitData(chunk);
      const detectorState = detectorStateWithoutOutputBuffer(pty);
      const internal = pty as unknown as {
        outputBuffer: { getSafeTailSince(cursor: number): string };
        promptOutputCursor: number;
      };
      const detectorCandidate = internal.outputBuffer.getSafeTailSince(internal.promptOutputCursor);
      expect(detectorState).not.toContain(chunk.trim());
      expect(detectorState).not.toContain(secret);
      expect(detectorCandidate).not.toContain(secret);
    }

    handle.emitExit(0);
    expect(JSON.stringify(pty)).not.toContain(secret);
  });

  it('caps answers at three even when the bypass dialog keeps rendering', async () => {
    const handle = makeFakePty();
    const pty = newAgentPty(handle);
    await pty.spawn('fresh', 'hello');

    handle.emitData('Bypass Permissions\n  1. No, exit\n  2. Yes, I accept\n');
    vi.advanceTimersByTime(5000);
    handle.emitData('Bypass Permissions\n  1. No, exit\n  2. Yes, I accept\n');
    vi.advanceTimersByTime(3000);
    handle.emitData('Bypass Permissions\n  1. No, exit\n  2. Yes, I accept\n');
    vi.advanceTimersByTime(3000);
    handle.emitData('Bypass Permissions\n  1. No, exit\n  2. Yes, I accept\n');
    vi.advanceTimersByTime(21000);

    expect(handle.fake.write.mock.calls.map((call) => call[0])).toEqual([
      '\x1b[B\r',
      '\x1b[B\r',
      '\x1b[B\r',
    ]);
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

  it('does not classify the real folder-trust dialog as a bypass gate', async () => {
    const handle = makeFakePty();
    const pty = newAgentPty(handle);
    await pty.spawn('fresh', 'hello');

    handle.emitData(REAL_FOLDER_TRUST_DIALOG);
    vi.advanceTimersByTime(5000);

    expect(handle.fake.write).toHaveBeenCalledWith('\r');
    expect(handle.fake.write).not.toHaveBeenCalledWith('\x1b[B\r');
  });

  it('accepts the real folder-trust dialog with the continue-without-permissions cancel label', async () => {
    const handle = makeFakePty();
    const pty = newAgentPty(handle);
    await pty.spawn('fresh', 'hello');

    handle.emitData(REAL_FOLDER_TRUST_PERMISSIONS_DIALOG);
    vi.advanceTimersByTime(5000);

    expect(handle.fake.write.mock.calls.map((call) => call[0])).toEqual(['\r']);
  });

  it('ignores conversation prose containing the shared dialog words and CLI flag', async () => {
    const handle = makeFakePty();
    const pty = newAgentPty(handle);
    await pty.spawn('fresh', 'hello');

    handle.emitData(
      'We trust the migration notes. The text mentions --dangerously-skip-permissions and No, exit, but no dialog is active.\n',
    );
    vi.advanceTimersByTime(32000);

    expect(handle.fake.write).not.toHaveBeenCalled();
  });

  it('answers trust then a newly rendered bypass gate once each in one boot', async () => {
    const handle = makeFakePty();
    const pty = newAgentPty(handle);
    await pty.spawn('fresh', 'hello');

    handle.emitData(REAL_FOLDER_TRUST_DIALOG);
    vi.advanceTimersByTime(5000);
    handle.emitData(REAL_BYPASS_DIALOG);
    vi.advanceTimersByTime(27000);

    expect(handle.fake.write.mock.calls.map((call) => call[0])).toEqual([
      '\r',
      '\x1b[B\r',
    ]);
  });

  it('answers a bypass dialog that renders after the original 8-second window', async () => {
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

    handle.emitData(REAL_FOLDER_TRUST_DIALOG);
    vi.advanceTimersByTime(5000);

    expect(handle.fake.write).not.toHaveBeenCalledWith('\x1b[B\r');
    expect(handle.fake.write).toHaveBeenCalledWith('\r');
  });

  it('does NOT fire after kill() — timers are cancelled, respawn is protected', async () => {
    const handle = makeFakePty();
    const pty = newAgentPty(handle);
    await pty.spawn('fresh', 'hello'); // t=0: timers armed for t=5s, t=8s
    handle.emitData(REAL_FOLDER_TRUST_DIALOG);

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
    expect(preflightMocks.ensureFolderTrusted).not.toHaveBeenCalled();
    expect(preflightMocks.ensureBypassPromptSuppressed).not.toHaveBeenCalled();
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
