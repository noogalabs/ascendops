import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const mockReadCrons = vi.fn();
const mockUpdateCron = vi.fn();
const mockReadCronsWithStatus = vi.fn();
const mockAppendExecutionLog = vi.fn();

vi.mock('../../../src/bus/crons.js', () => ({
  readCrons: (...a: unknown[]) => mockReadCrons(...a),
  readCronsWithStatus: (...a: unknown[]) => mockReadCronsWithStatus(...a),
  updateCron: (...a: unknown[]) => mockUpdateCron(...a),
}));

vi.mock('../../../src/daemon/cron-execution-log.js', () => ({
  appendExecutionLog: (...a: unknown[]) => mockAppendExecutionLog(...a),
}));

import { CronScheduler } from '../../../src/daemon/cron-scheduler.js';
import type { CronDefinition } from '../../../src/types/index.js';

/** A cron whose last fire is long past, so its next fire is overdue on load. */
function overdueCron(name: string): CronDefinition {
  return {
    name,
    prompt: 'Do something.',
    schedule: '1m',
    enabled: true,
    created_at: new Date(Date.now() - 3_600_000).toISOString(),
    last_fired_at: new Date(Date.now() - 600_000).toISOString(), // 10 min ago
  } as CronDefinition;
}

describe('cron catch-up marking', () => {
  let scheduler: CronScheduler;
  let fired: CronDefinition[];
  let logs: string[];

  beforeEach(() => {
    vi.useFakeTimers();
    fired = []; logs = [];
    mockReadCrons.mockReset(); mockUpdateCron.mockReset();
    mockAppendExecutionLog.mockReset();
    mockReadCronsWithStatus.mockImplementation((agent: string) => ({
      crons: mockReadCrons(agent) ?? [], corrupt: false,
    }));
    scheduler = new CronScheduler({
      agentName: 'test-agent',
      onFire: (c) => { fired.push(c); },
      logger: (m) => { logs.push(m); },
    });
  });

  afterEach(() => { scheduler.stop(); vi.useRealTimers(); });

  const catchUpLogs = () => logs.filter((l) => l.includes('catch-up:'));
  const fireLogs = () => logs.filter((l) => l.includes('firing cron'));

  // THE STANDING QUESTION: would this fail if catch-up replayed every missed window?
  // YES. Each cron is ten windows overdue, but the first tick must dispatch it once.
  it('TC-J2: fire-once-then-advance is preserved (exactly one catch-up each)', async () => {
    mockReadCrons.mockReturnValue([overdueCron('a'), overdueCron('b')]);
    scheduler.start();

    await vi.advanceTimersByTimeAsync(CronScheduler.TICK_INTERVAL_MS);

    expect(fired.map((cron) => cron.name)).toEqual(['a', 'b']);
    expect(fireLogs().filter((line) => line.includes('[catch-up]'))).toHaveLength(2);
  });

  // Reviewer's instrument gap: a caught-up fire and a due fire are otherwise
  // indistinguishable in the record, which is how a post-restart replay reads
  // as normal operation.
  it('TC-J3: catch-up fires are marked distinguishable from due fires', async () => {
    mockReadCrons.mockReturnValue([overdueCron('a')]);
    scheduler.start();

    await vi.advanceTimersByTimeAsync(CronScheduler.TICK_INTERVAL_MS);

    expect(catchUpLogs()[0]).toContain('one immediate catch-up');
    expect(fireLogs()).toEqual([
      expect.stringContaining('firing cron "a" [catch-up]'),
    ]);
    expect(mockAppendExecutionLog.mock.calls.map((call) => call[1]?.fire_kind)).toEqual([
      'catch_up',
    ]);

    // The scheduler clears its transient caughtUp state before dispatch. The
    // next normal fire must still be distinguishable from the persisted
    // catch-up record.
    await vi.advanceTimersByTimeAsync(CronScheduler.TICK_INTERVAL_MS * 2);
    expect(mockAppendExecutionLog.mock.calls.map((call) => call[1]?.fire_kind)).toEqual([
      'catch_up',
      'scheduled',
    ]);
  });

  it('TC-J6: every retry entry preserves the catch-up fire kind', async () => {
    let attempts = 0;
    scheduler.stop();
    scheduler = new CronScheduler({
      agentName: 'test-agent',
      onFire: () => {
        attempts += 1;
        if (attempts < 3) throw new Error(`transient ${attempts}`);
      },
      logger: (m) => { logs.push(m); },
    });
    mockReadCrons.mockReturnValue([overdueCron('retrying')]);
    scheduler.start();

    await vi.advanceTimersByTimeAsync(CronScheduler.TICK_INTERVAL_MS + 5_000);

    expect(mockAppendExecutionLog.mock.calls.map((call) => ({
      status: call[1]?.status,
      fireKind: call[1]?.fire_kind,
    }))).toEqual([
      { status: 'retried', fireKind: 'catch_up' },
      { status: 'retried', fireKind: 'catch_up' },
      { status: 'fired', fireKind: 'catch_up' },
    ]);
  });

  it('TC-J4: a not-overdue cron fires without the catch-up marker', async () => {
    mockReadCrons.mockReturnValue([{
      name: 'fresh', prompt: 'x', schedule: '1m', enabled: true,
      created_at: new Date().toISOString(),
    } as CronDefinition]);
    scheduler.start();

    await vi.advanceTimersByTimeAsync(CronScheduler.TICK_INTERVAL_MS * 2);

    expect(catchUpLogs()).toHaveLength(0);
    expect(fired.map((cron) => cron.name)).toEqual(['fresh']);
    expect(fireLogs()).toHaveLength(1);
    expect(fireLogs()[0]).not.toContain('[catch-up]');
  });

  it('TC-J5: corrupt reload preserves the pending catch-up marker', async () => {
    mockReadCrons.mockReturnValue([overdueCron('a')]);
    scheduler.start();

    mockReadCronsWithStatus.mockReturnValue({ crons: [], corrupt: true });
    scheduler.reload();
    await vi.advanceTimersByTimeAsync(CronScheduler.TICK_INTERVAL_MS);

    expect(fired.map((cron) => cron.name)).toEqual(['a']);
    expect(fireLogs()).toEqual([
      expect.stringContaining('firing cron "a" [catch-up]'),
    ]);
  });
});
