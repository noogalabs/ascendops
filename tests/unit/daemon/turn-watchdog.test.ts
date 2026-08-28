import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  closeSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readSync,
  rmSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
} from 'fs';
import { execFile } from 'child_process';
import { join } from 'path';
import { tmpdir } from 'os';
import { FastChecker, meaningfulPrintableLines, readFileRangeSync } from '../../../src/daemon/fast-checker';
import type { BusPaths } from '../../../src/types';

vi.mock('child_process', () => ({ execFile: vi.fn() }));

function createPaths(root: string): BusPaths {
  const paths: BusPaths = {
    ctxRoot: root,
    inbox: join(root, 'inbox'),
    inflight: join(root, 'inflight'),
    processed: join(root, 'processed'),
    logDir: join(root, 'logs'),
    stateDir: join(root, 'state'),
    taskDir: join(root, 'tasks'),
    approvalDir: join(root, 'approvals'),
    analyticsDir: join(root, 'analytics'),
    heartbeatDir: join(root, 'heartbeats'),
    deliverablesDir: join(root, 'deliverables'),
  };
  Object.values(paths).forEach((path) => mkdirSync(path, { recursive: true }));
  return paths;
}

function createAgent() {
  let lastInjectedAt = 0;
  return {
    name: 'carolina',
    getConfig: vi.fn().mockReturnValue({ timezone: '' }),
    getStatus: vi.fn().mockReturnValue({ status: 'running' }),
    sessionRefresh: vi.fn().mockResolvedValue(undefined),
    injectMessage: vi.fn().mockReturnValue(true),
    injectMessageDetailed: vi.fn().mockReturnValue({ ok: true }),
    getLastInjectedAt: vi.fn(() => lastInjectedAt),
    setLastInjectedAt: (at: number) => { lastInjectedAt = at; },
  } as any;
}

describe('stalled-turn watchdog (WS-B)', () => {
  let root: string;
  let paths: BusPaths;
  const now = new Date('2026-07-16T18:00:00.000Z').getTime();

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(now);
    root = mkdtempSync(join(tmpdir(), 'turn-watchdog-'));
    paths = createPaths(root);
  });

  afterEach(() => {
    vi.useRealTimers();
    rmSync(root, { recursive: true, force: true });
  });

  function createChecker(
    agent: ReturnType<typeof createAgent>,
    thresholdMinutes = 30,
    options: Record<string, unknown> = {},
  ): any {
    const checker = new FastChecker(agent, paths, '/framework', {
      turnWatchdogThresholdMinutes: thresholdMinutes,
      log: vi.fn(),
      ...options,
    } as any) as any;
    checker.bootstrappedAt = now - 48 * 60 * 60_000;
    checker.sessionStartedAt = Date.now() - 1_000;
    writeFileSync(join(paths.logDir, 'stdout.log'), '');
    checker.watchdogCheck(); // Seed the incremental stdout cursor.
    return checker;
  }

  function armWatchdog(checker: any, idleAt = Date.now() - 48 * 60 * 60_000): void {
    const flagPath = join(paths.stateDir, 'last_idle.flag');
    writeFileSync(flagPath, String(Math.floor(idleAt / 1000)));
    const observedAt = new Date(checker.sessionStartedAt + 1);
    utimesSync(flagPath, observedAt, observedAt);
    checker.watchdogCheck();
  }

  function statusFixtureLines(): string[] {
    return readFileSync(
      join(process.cwd(), 'tests/fixtures/daemon/stdout-status-lines.txt'),
      'utf8',
    ).split('\n').filter((line) => line && !line.startsWith('#'));
  }

  function tickingFixtureChunk(iteration: number): string {
    return `${statusFixtureLines().map((line) =>
      line.replace(/\d+/g, (digits) => String(Number.parseInt(digits, 10) + iteration)),
    ).join('\n')}\n`;
  }

  it('uses the real scrubbed corpus to detect a stalled turn despite ticking status numerics', () => {
    const agent = createAgent();
    const checker = createChecker(agent);
    armWatchdog(checker);
    agent.setLastInjectedAt(now - 47 * 60 * 60_000);

    for (let iteration = 1; iteration <= 3; iteration += 1) {
      vi.setSystemTime(now - (4 - iteration) * 20 * 60_000);
      writeFileSync(join(paths.logDir, 'stdout.log'), tickingFixtureChunk(iteration), { flag: 'a' });
      checker.watchdogCheck();
    }

    vi.setSystemTime(now);
    checker.watchdogCheck();
    expect(agent.sessionRefresh).toHaveBeenCalledTimes(1);
    expect(checker.turnHung).toBe(true);
  });

  it('does not call a legitimate ticking turn hung when genuine output remains novel', () => {
    const agent = createAgent();
    const checker = createChecker(agent);
    armWatchdog(checker);
    agent.setLastInjectedAt(now - 47 * 60 * 60_000);

    for (let iteration = 1; iteration <= 3; iteration += 1) {
      vi.setSystemTime(now - (4 - iteration) * 20 * 60_000);
      writeFileSync(
        join(paths.logDir, 'stdout.log'),
        `${tickingFixtureChunk(iteration)}compiled package ${iteration} successfully\n`,
        { flag: 'a' },
      );
      checker.watchdogCheck();
    }

    vi.setSystemTime(now);
    checker.watchdogCheck();
    expect(agent.sessionRefresh).not.toHaveBeenCalled();
    expect(checker.turnHung).toBe(false);
  });

  it('filters the labeled-synthetic measured status shape for every added glyph prefix', () => {
    const measuredShape = (prefix: string) => `${prefix} Thinking (3m 2s · ↓1.2k tokens)`;
    const addedPrefixes = ['·', '•', '*', '+', '◯', '○', '●', '◦'];

    expect(meaningfulPrintableLines(addedPrefixes.map(measuredShape).join('\n'))).toEqual([]);
  });

  it('stays inactive when no idle-flag writer has been observed this session', () => {
    const agent = createAgent();
    const checker = createChecker(agent);
    agent.setLastInjectedAt(now - 47 * 60 * 60_000);
    writeFileSync(
      join(paths.logDir, 'stdout.log'),
      ('\x1b[2K\r\x1b[36m⣋\x1b[0m\r\x1b[2K\x1b[1G⣙\r').repeat(200),
    );

    checker.watchdogCheck();

    expect(agent.sessionRefresh).not.toHaveBeenCalled();
    expect(checker.turnHung).toBe(false);
    expect(existsSync(join(paths.stateDir, 'heartbeat.json'))).toBe(false);
    expect(checker.log.mock.calls.filter(([message]: [string]) =>
      message.includes('turn watchdog inactive'),
    )).toHaveLength(1);
  });

  it('stays inactive when the idle flag predates this session', () => {
    const agent = createAgent();
    const checker = createChecker(agent);
    const flagPath = join(paths.stateDir, 'last_idle.flag');
    writeFileSync(flagPath, String(Math.floor((now - 48 * 60 * 60_000) / 1000)));
    const staleAt = new Date(checker.sessionStartedAt - 1);
    utimesSync(flagPath, staleAt, staleAt);
    agent.setLastInjectedAt(now - 47 * 60 * 60_000);

    checker.watchdogCheck();

    expect(agent.sessionRefresh).not.toHaveBeenCalled();
    expect(checker.turnHung).toBe(false);
  });

  it('fires after an in-session idle write, then a consumed inject and 47h of spinner-only output', () => {
    const agent = createAgent();
    const checker = createChecker(agent);
    armWatchdog(checker);
    agent.setLastInjectedAt(now - 47 * 60 * 60_000);
    writeFileSync(
      join(paths.logDir, 'stdout.log'),
      ('\x1b[2K\r\x1b[36m⣋\x1b[0m\r\x1b[2K\x1b[1G⣙\r' +
        '✻ Working... 1s\r✽ Working... 2s\r✶ Working... 3s\r').repeat(200),
    );

    checker.watchdogCheck();

    expect(agent.sessionRefresh).toHaveBeenCalledTimes(1);
    expect(checker.turnHung).toBe(true);
    const heartbeat = JSON.parse(readFileSync(join(paths.stateDir, 'heartbeat.json'), 'utf-8'));
    expect(heartbeat.status).toContain('HUNG');
    expect(vi.mocked(execFile).mock.calls.some((call) => JSON.stringify(call).includes('HUNG'))).toBe(false);
  });

  it('treats a Stop flag newer than the inject as idle and never fires', () => {
    const agent = createAgent();
    const checker = createChecker(agent);
    agent.setLastInjectedAt(now - 60 * 60_000);
    armWatchdog(checker, now - 30 * 60_000);

    checker.watchdogCheck();

    expect(agent.sessionRefresh).not.toHaveBeenCalled();
    expect(checker.turnHung).toBe(false);
  });

  it('does not fire for an empty inbox that has been silent for days', () => {
    const agent = createAgent();
    const checker = createChecker(agent);

    checker.watchdogCheck();

    expect(agent.sessionRefresh).not.toHaveBeenCalled();
    expect(checker.turnHung).toBe(false);
  });

  it('does not fire during a long legitimate turn with periodic meaningful tool output', () => {
    const agent = createAgent();
    const checker = createChecker(agent);
    armWatchdog(checker);
    agent.setLastInjectedAt(now - 4 * 60 * 60_000);

    for (let i = 0; i < 7; i += 1) {
      vi.setSystemTime(now - (7 - i) * 20 * 60_000);
      writeFileSync(
        join(paths.logDir, 'stdout.log'),
        `${'\x1b[2K\r⣋\r'.repeat(20)}compiled package ${i + 1} successfully\n`,
        { flag: 'a' },
      );
      checker.watchdogCheck();
    }

    vi.setSystemTime(now);
    checker.watchdogCheck();
    expect(agent.sessionRefresh).not.toHaveBeenCalled();
    expect(checker.lastMeaningfulOutputAt).toBe(now - 20 * 60_000);
    expect(checker.turnHung).toBe(false);
  });

  it('caps repeated hangs at two recoveries per 6h and makes the third alert-only', () => {
    const agent = createAgent();
    let checker: any;

    for (let attempt = 0; attempt < 3; attempt += 1) {
      const attemptNow = now + attempt * 90 * 60_000;
      vi.setSystemTime(attemptNow);
      agent.setLastInjectedAt(0);
      checker = createChecker(agent, 30); // Recreate to prove persisted cap state is reloaded.
      armWatchdog(checker, attemptNow - 48 * 60 * 60_000);
      agent.setLastInjectedAt(attemptNow - 31 * 60_000);
      checker.watchdogCheck();
    }

    expect(agent.sessionRefresh).toHaveBeenCalledTimes(2);
    expect(checker.turnWatchdogRecoveries).toHaveLength(2);
    expect(checker.turnHung).toBe(true);
    expect(checker.log).toHaveBeenCalledWith(expect.stringContaining('alert-only'));
  });

  it('fails closed to alert-only when the recovery reservation cannot be persisted', () => {
    const agent = createAgent();
    const telegramApi = { sendMessage: vi.fn().mockResolvedValue({ ok: true }) };
    const checker = createChecker(agent, 30, { telegramApi, chatId: '123' });
    armWatchdog(checker);
    agent.setLastInjectedAt(now - 31 * 60_000);
    rmSync(paths.stateDir, { recursive: true, force: true });
    writeFileSync(paths.stateDir, 'not a directory');

    checker.watchdogCheck();

    expect(agent.sessionRefresh).not.toHaveBeenCalled();
    expect(checker.turnWatchdogRecoveries).toHaveLength(0);
    expect(checker.log).toHaveBeenCalledWith(expect.stringContaining('persistence failed'));
    expect(telegramApi.sendMessage).toHaveBeenCalledWith(
      '123',
      expect.stringMatching(/persist|state could not be saved/i),
    );
    expect(telegramApi.sendMessage.mock.calls[0][1]).not.toMatch(/capped|2 attempts/i);
  });

  it('never recovers the triggering injection again after reset, even far past threshold', () => {
    const agent = createAgent();
    const checker = createChecker(agent);
    armWatchdog(checker);
    agent.setLastInjectedAt(now - 31 * 60_000);
    checker.watchdogCheck();
    expect(agent.sessionRefresh).toHaveBeenCalledTimes(1);

    checker.resetWatchdogState();
    armWatchdog(checker);
    checker.watchdogCheck();
    expect(agent.sessionRefresh).toHaveBeenCalledTimes(1);
    expect(checker.turnHung).toBe(false);

    vi.setSystemTime(now + 24 * 60 * 60_000);
    checker.watchdogCheck();
    expect(agent.sessionRefresh).toHaveBeenCalledTimes(1);
  });

  it('allows a genuinely new injection to recover after reset, subject to the cap', () => {
    const agent = createAgent();
    const checker = createChecker(agent);
    armWatchdog(checker);
    agent.setLastInjectedAt(now - 31 * 60_000);
    checker.watchdogCheck();
    expect(agent.sessionRefresh).toHaveBeenCalledTimes(1);

    checker.resetWatchdogState();
    armWatchdog(checker);
    vi.setSystemTime(now + 60 * 60_000);
    agent.setLastInjectedAt(now + 29 * 60_000);
    checker.watchdogCheck();

    expect(agent.sessionRefresh).toHaveBeenCalledTimes(2);
  });

  it('treats an existing malformed recovery file as alert-only state', () => {
    writeFileSync(
      join(paths.stateDir, '.turn-watchdog-recoveries.json'),
      JSON.stringify({ recoveries: [now - 60_000, 'invalid'] }),
    );
    const agent = createAgent();
    const checker = createChecker(agent);
    armWatchdog(checker);
    agent.setLastInjectedAt(now - 31 * 60_000);

    checker.watchdogCheck();

    expect(agent.sessionRefresh).not.toHaveBeenCalled();
    expect(checker.log).toHaveBeenCalledWith(expect.stringContaining('recovery state unavailable'));
  });

  it('restores recovery after the operator deletes a malformed state file', () => {
    const recoveryFile = join(paths.stateDir, '.turn-watchdog-recoveries.json');
    writeFileSync(recoveryFile, JSON.stringify({ recoveries: [now - 60_000, 'invalid'] }));
    const agent = createAgent();
    const checker = createChecker(agent);
    armWatchdog(checker);
    agent.setLastInjectedAt(now - 31 * 60_000);

    checker.watchdogCheck();
    expect(agent.sessionRefresh).not.toHaveBeenCalled();

    unlinkSync(recoveryFile);
    vi.setSystemTime(now + 60 * 60_000);
    agent.setLastInjectedAt(now + 29 * 60_000);
    checker.watchdogCheck();

    expect(agent.sessionRefresh).toHaveBeenCalledTimes(1);
  });

  it('caps a large stdout delta read while retaining meaningful tail output', () => {
    const lengths: number[] = [];
    const fileRangeOps = {
      openSync,
      readSync: (fd: number, buffer: Buffer, offset: number, length: number, position: number) => {
        lengths.push(length);
        return readSync(fd, buffer, offset, length, position);
      },
      closeSync,
    };
    const checker = createChecker(createAgent(), 30, { fileRangeOps });
    const payload = Buffer.concat([
      Buffer.alloc(1024 * 1024, 'x'),
      Buffer.from('\ncompiled package successfully\n'),
    ]);
    writeFileSync(join(paths.logDir, 'stdout.log'), payload);

    checker.watchdogCheck();

    expect(lengths.length).toBeGreaterThan(0);
    expect(lengths.every((length) => length <= 256 * 1024)).toBe(true);
    expect(checker.lastMeaningfulOutputAt).toBe(now);
  });

  it('reads an entire small stdout delta and detects its meaningful line', () => {
    const lengths: number[] = [];
    const fileRangeOps = {
      openSync,
      readSync: (fd: number, buffer: Buffer, offset: number, length: number, position: number) => {
        lengths.push(length);
        return readSync(fd, buffer, offset, length, position);
      },
      closeSync,
    };
    const checker = createChecker(createAgent(), 30, { fileRangeOps });
    const payload = Buffer.from('compiled package successfully\n');
    writeFileSync(join(paths.logDir, 'stdout.log'), payload);

    checker.watchdogCheck();

    expect(lengths).toEqual([payload.length]);
    expect(checker.lastMeaningfulOutputAt).toBe(now);
  });

  it('closes the stdout descriptor when an incremental read throws', () => {
    const close = vi.fn();
    const read = vi.fn(() => { throw new Error('simulated read failure'); });

    expect(() => readFileRangeSync('/tmp/stdout.log', 0, 10, {
      openSync: vi.fn(() => 42),
      readSync: read,
      closeSync: close,
    })).toThrow('simulated read failure');
    expect(close).toHaveBeenCalledWith(42);
  });
});
