import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import type { CronFireContext } from '../../../src/daemon/cron-scheduler.js';
import type { CronDefinition } from '../../../src/types/index.js';

// Mock the PTY/Telegram layers — same shape as the existing
// agent-manager.test.ts so we can construct AgentManager without spawning
// anything real. The inspect helper is pure logic over the agents Map; we
// only need to control what is in / out of the Map.
vi.mock('../../../src/daemon/agent-process.js', () => ({
  AgentProcess: class {
    name: string;
    dir: string;
    constructor(name: string, dir: string) { this.name = name; this.dir = dir; }
    async start() { /* no-op */ }
    async stop() { /* no-op */ }
    getStatus() { return { name: this.name, status: 'stopped' }; }
    onExit() { /* no-op */ }
  },
}));
vi.mock('../../../src/daemon/fast-checker.js', () => ({
  FastChecker: class { start() {} stop() {} wake() {} },
}));
vi.mock('../../../src/telegram/api.js', () => ({ TelegramAPI: class { constructor() {} } }));
vi.mock('../../../src/telegram/poller.js', () => ({ TelegramPoller: class { start() {} stop() {} } }));
const logEventMock = vi.fn();
vi.mock('../../../src/bus/event.js', () => ({ logEvent: logEventMock }));

const { AgentManager } = await import('../../../src/daemon/agent-manager.js');
const { fireWithRetry } = await import('../../../src/daemon/cron-scheduler.js');
const { MessageDedup } = await import('../../../src/pty/inject.js');

describe('AgentManager.inspectAgentOp — issue #346 (DEDUPED vs NOT_FOUND)', () => {
  let testDir: string;
  let am: InstanceType<typeof AgentManager>;

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), 'cortextos-inspect-test-'));
    mkdirSync(join(testDir, 'framework'), { recursive: true });
    am = new AgentManager('test-instance', join(testDir, 'instance'), join(testDir, 'framework'), 'acme');
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  it('start on empty registry: ok (queued)', () => {
    const r = am.inspectAgentOp('start', 'alice');
    expect(r.ok).toBe(true);
  });

  it('start when agent already in registry: DEDUPED (not NOT_FOUND)', () => {
    // Simulate an in-flight start by injecting an entry into the private map.
    // This is the exact precondition that triggers the BUG-011 dedup branch
    // in startAgent — we need to confirm it surfaces as DEDUPED, not NOT_FOUND.
    (am as unknown as { agents: Map<string, unknown> }).agents.set('alice', {
      process: { getStatus: () => ({ name: 'alice', status: 'starting' }) },
    });

    const r = am.inspectAgentOp('start', 'alice');
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.code).toBe('DEDUPED');
      expect(r.message).toMatch(/already in registry/);
      expect(r.message).toContain('alice');
    }
  });

  it('stop on empty registry: NOT_FOUND (the misreport bug — must distinguish)', () => {
    const r = am.inspectAgentOp('stop', 'ghost');
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.code).toBe('NOT_FOUND');
      expect(r.message).toMatch(/not in registry/);
      expect(r.message).toContain('ghost');
      expect(r.message).toContain('stop');
    }
  });

  it('restart on empty registry: NOT_FOUND', () => {
    const r = am.inspectAgentOp('restart', 'ghost');
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.code).toBe('NOT_FOUND');
      expect(r.message).toContain('restart');
    }
  });

  it('stop on agent in registry: ok', () => {
    (am as unknown as { agents: Map<string, unknown> }).agents.set('alice', {} as unknown);
    const r = am.inspectAgentOp('stop', 'alice');
    expect(r.ok).toBe(true);
  });

  it('restart on agent in registry: ok', () => {
    (am as unknown as { agents: Map<string, unknown> }).agents.set('alice', {} as unknown);
    const r = am.inspectAgentOp('restart', 'alice');
    expect(r.ok).toBe(true);
  });

  it('inspectAgentOp does not mutate the agents map (read-only check)', () => {
    const before = (am as unknown as { agents: Map<string, unknown> }).agents.size;
    am.inspectAgentOp('start', 'alice');
    am.inspectAgentOp('stop', 'ghost');
    am.inspectAgentOp('restart', 'phantom');
    const after = (am as unknown as { agents: Map<string, unknown> }).agents.size;
    expect(after).toBe(before);
  });
});

describe('AgentManager dead mapped-agent recovery (#858)', () => {
  let testDir: string;
  let am: InstanceType<typeof AgentManager>;

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), 'cortextos-dead-map-test-'));
    mkdirSync(join(testDir, 'framework'), { recursive: true });
    am = new AgentManager('test-instance', join(testDir, 'instance'), join(testDir, 'framework'), 'acme');
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  it.each(['stopped', 'crashed', 'halted', 'rate-limited'])('allows start admission for a mapped %s entry', (status) => {
    (am as unknown as { agents: Map<string, unknown> }).agents.set('alice', {
      process: { getStatus: () => ({ name: 'alice', status }) },
    });
    expect(am.inspectAgentOp('start', 'alice')).toEqual({ ok: true });
  });

  it.each(['starting', 'running'])('dedupes start admission for a mapped %s entry', (status) => {
    (am as unknown as { agents: Map<string, unknown> }).agents.set('alice', {
      process: { getStatus: () => ({ name: 'alice', status }) },
    });
    expect(am.inspectAgentOp('start', 'alice')).toMatchObject({ ok: false, code: 'DEDUPED' });
  });

  it('evicts one stale entry across concurrent starts', async () => {
    let releaseStop!: () => void;
    const stopGate = new Promise<void>((resolve) => { releaseStop = resolve; });
    const processStop = vi.fn(() => stopGate);
    const checkerStop = vi.fn();
    const stale = {
      process: { getStatus: () => ({ name: 'alice', status: 'halted' }), stop: processStop },
      checker: { stop: checkerStop },
    };
    const privateState = am as unknown as {
      agents: Map<string, unknown>;
      evictingAgents: Set<string>;
      pendingRestarts: Map<string, unknown>;
    };
    privateState.agents.set('alice', stale);

    const first = am.startAgent('alice', '');
    const second = am.startAgent('alice', '');
    await second;

    expect(processStop).toHaveBeenCalledTimes(1);
    expect(privateState.evictingAgents.has('alice')).toBe(true);
    releaseStop();
    await first;
    expect(checkerStop).toHaveBeenCalledTimes(1);
    expect(privateState.evictingAgents.has('alice')).toBe(false);
    expect(privateState.pendingRestarts.has('alice')).toBe(false);
    expect(privateState.agents.has('alice')).toBe(false);
  });
});

describe('AgentManager explicit stop wins over queued restart (#859)', () => {
  it('drops the pending restart after an explicit user stop', async () => {
    const root = mkdtempSync(join(tmpdir(), 'cortextos-stop-wins-test-'));
    try {
      const am = new AgentManager('test-instance', join(root, 'instance'), join(root, 'framework'), 'acme');
      const privateState = am as unknown as {
        agents: Map<string, unknown>;
        pendingRestarts: Map<string, { cause: 'in-flight-duplicate'; queuedAt: number }>;
      };
      privateState.agents.set('alice', {
        process: { stop: vi.fn().mockResolvedValue(undefined) },
        checker: { stop: vi.fn() },
      });
      privateState.pendingRestarts.set('alice', { cause: 'in-flight-duplicate', queuedAt: Date.now() });
      const start = vi.spyOn(am, 'startAgent').mockResolvedValue();

      await am.stopAgent('alice', true);

      expect(privateState.pendingRestarts.has('alice')).toBe(false);
      expect(start).not.toHaveBeenCalled();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('AgentManager.injectAgentDetailed — issue #346 (NOT_FOUND vs NOT_RUNNING vs DEDUPED)', () => {
  let testDir: string;
  let am: InstanceType<typeof AgentManager>;

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), 'cortextos-inject-test-'));
    mkdirSync(join(testDir, 'framework'), { recursive: true });
    am = new AgentManager('test-instance', join(testDir, 'instance'), join(testDir, 'framework'), 'acme');
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  it('agent not in registry: NOT_FOUND (the actual harness misreport surface)', () => {
    const r = am.injectAgentDetailed('ghost', 'hello');
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.code).toBe('NOT_FOUND');
      expect(r.message).toContain('ghost');
      expect(r.message).toMatch(/not in registry/);
    }
  });

  it('agent in registry but PTY dead: NOT_RUNNING (was conflated with NOT_FOUND)', () => {
    // Inject a fake entry whose process reports NOT_RUNNING.
    const fakeEntry = {
      process: {
        injectMessageDetailed: () => ({ ok: false, code: 'NOT_RUNNING' as const, message: 'agent "alice" is registered but not running (status: stopped)' }),
      },
    };
    (am as unknown as { agents: Map<string, unknown> }).agents.set('alice', fakeEntry);
    const r = am.injectAgentDetailed('alice', 'hello');
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.code).toBe('NOT_RUNNING');
      expect(r.message).toMatch(/registered but not running/);
    }
  });

  it('agent running but content matches dedup window: DEDUPED (the cron-salt collision case)', () => {
    const fakeEntry = {
      process: {
        injectMessageDetailed: () => ({ ok: false, code: 'DEDUPED' as const, message: 'inject for "alice" deduped — content matches MessageDedup hash window' }),
      },
    };
    (am as unknown as { agents: Map<string, unknown> }).agents.set('alice', fakeEntry);
    const r = am.injectAgentDetailed('alice', 'duplicate-content');
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.code).toBe('DEDUPED');
      expect(r.message).toMatch(/MessageDedup/);
    }
  });

  it('agent running, novel content: ok', () => {
    const fakeEntry = {
      process: {
        injectMessageDetailed: () => ({ ok: true as const }),
      },
    };
    (am as unknown as { agents: Map<string, unknown> }).agents.set('alice', fakeEntry);
    const r = am.injectAgentDetailed('alice', 'novel-content');
    expect(r.ok).toBe(true);
  });

  it('boolean injectAgent stays back-compat — NOT_FOUND collapses to false', () => {
    expect(am.injectAgent('ghost', 'hello')).toBe(false);
  });

  it('boolean injectAgent stays back-compat — DEDUPED collapses to false', () => {
    const fakeEntry = {
      process: {
        injectMessageDetailed: () => ({ ok: false, code: 'DEDUPED' as const, message: 'x' }),
      },
    };
    (am as unknown as { agents: Map<string, unknown> }).agents.set('alice', fakeEntry);
    expect(am.injectAgent('alice', 'x')).toBe(false);
  });

  it('boolean injectAgent stays back-compat — ok collapses to true', () => {
    const fakeEntry = {
      process: {
        injectMessageDetailed: () => ({ ok: true as const }),
      },
    };
    (am as unknown as { agents: Map<string, unknown> }).agents.set('alice', fakeEntry);
    expect(am.injectAgent('alice', 'x')).toBe(true);
  });

  it('attaches the reviewed Terra preflight and Sol continuation only through injectCronAgent', () => {
    const agentDir = join(testDir, 'framework', 'orgs', 'acme', 'agents', 'alice');
    const preflight = join(
      testDir,
      'framework/config/codex-cron-routing/heartbeat-preflight.md',
    );
    mkdirSync(join(preflight, '..'), { recursive: true });
    writeFileSync(preflight, readFileSync(join(
      process.cwd(),
      'config/codex-cron-routing/heartbeat-preflight.md',
    )));
    const injectMessageDetailed = vi.fn().mockReturnValue({ ok: true as const });
    const fakeEntry = {
      process: {
        getConfig: () => ({ runtime: 'codex-app-server', model: 'gpt-5.6-sol' }),
        injectMessageDetailed,
      },
    };
    (am as unknown as { agents: Map<string, unknown> }).agents.set('alice', fakeEntry);

    expect(am.injectCronAgent('alice', {
      name: 'heartbeat',
      prompt: 'Read HEARTBEAT.md and follow its instructions. Update your heartbeat, check inbox, and work on your highest priority task.',
    }, '[CRON FIRED]')).toBe(true);
    expect(injectMessageDetailed).toHaveBeenCalledWith(expect.stringContaining('[CRON PREFLIGHT] heartbeat'), {
      codexRouting: expect.objectContaining({
        source: 'daemon-cron',
        cronName: 'heartbeat',
        model: 'gpt-5.6-terra',
        reason: 'reviewed_mechanical_preflight',
      }),
      codexContinuation: expect.stringContaining('[CRON CONTINUATION] heartbeat'),
      codexFallback: expect.stringContaining('[CRON FALLBACK] heartbeat'),
      dedupIdentity: expect.stringMatching(/^daemon-cron:heartbeat:/),
    });
    expect(logEventMock).toHaveBeenCalledWith(
      expect.anything(),
      'alice',
      expect.anything(),
      'action',
      'cron_model_route_planned',
      'info',
      expect.objectContaining({ cron: 'heartbeat', model: 'gpt-5.6-terra' }),
    );
  });

  it('keeps reviewed preflight bytes exact while assigning each cron fire a distinct dedup identity', () => {
    const injectMessageDetailed = vi.fn().mockReturnValue({ ok: true as const });
    const fakeEntry = {
      process: {
        getConfig: () => ({ runtime: 'codex-app-server', model: 'gpt-5.6-sol' }),
        injectMessageDetailed,
      },
    };
    (am as unknown as { agents: Map<string, unknown> }).agents.set('alice', fakeEntry);
    const cron = {
      name: 'heartbeat',
      prompt: 'Read HEARTBEAT.md and follow its instructions. Update your heartbeat, check inbox, and work on your highest priority task.',
    };

    expect(am.injectCronAgent('alice', cron, 'salted scheduler text one', '2026-08-05T01:00:00.000Z')).toBe(true);
    expect(am.injectCronAgent('alice', cron, 'salted scheduler text two', '2026-08-05T07:00:00.000Z')).toBe(true);

    const [firstContent, firstOptions] = injectMessageDetailed.mock.calls[0];
    const [secondContent, secondOptions] = injectMessageDetailed.mock.calls[1];
    expect(secondContent).toBe(firstContent);
    expect(firstContent).toContain('[CRON PREFLIGHT] heartbeat');
    expect(firstOptions.dedupIdentity).toBe('daemon-cron:heartbeat:2026-08-05T01:00:00.000Z');
    expect(secondOptions.dedupIdentity).toBe('daemon-cron:heartbeat:2026-08-05T07:00:00.000Z');
  });

  it('accepts only a value-bound structured duplicate as routed retry success', () => {
    const cron = {
      name: 'heartbeat',
      prompt: 'Read HEARTBEAT.md and follow its instructions. Update your heartbeat, check inbox, and work on your highest priority task.',
    };
    const firedAt = '2026-08-05T01:00:00.000Z';
    const identity = `daemon-cron:heartbeat:${firedAt}`;
    const injectMessageDetailed = vi.fn()
      .mockReturnValueOnce({ ok: false as const, code: 'DEDUPED' as const, message: 'ordinary collision' })
      .mockReturnValueOnce({
        ok: false as const,
        code: 'DEDUPED' as const,
        message: 'different structured fire',
        dedupIdentity: 'daemon-cron:heartbeat:different-fire',
      })
      .mockReturnValueOnce({
        ok: false as const,
        code: 'DEDUPED' as const,
        message: 'same admitted structured fire',
        dedupIdentity: identity,
      });
    (am as unknown as { agents: Map<string, unknown> }).agents.set('alice', {
      process: {
        getConfig: () => ({ runtime: 'codex-app-server', model: 'gpt-5.6-sol' }),
        injectMessageDetailed,
      },
    });

    expect(am.injectCronAgent('alice', cron, 'scheduler text', firedAt)).toBe(false);
    expect(am.injectCronAgent('alice', cron, 'scheduler text', firedAt)).toBe(false);
    expect(am.injectCronAgent('alice', cron, 'scheduler text', firedAt)).toBe(true);
  });

  it('reuses one admitted identity when scheduler retry follows an ambiguous dispatch', async () => {
    vi.useFakeTimers();
    try {
      const dedup = new MessageDedup();
      const sequenceStarts: string[] = [];
      let failAfterFirstSequence = true;
      const fakeEntry = {
        process: {
          getConfig: () => ({ runtime: 'codex-app-server', model: 'gpt-5.6-sol' }),
          injectMessageDetailed: vi.fn((content: string, options: { dedupIdentity?: string; codexRouting?: { model: string } }) => {
            if (dedup.isDuplicate(options.dedupIdentity ?? content, 'daemon-structured')) {
              return {
                ok: false as const,
                code: 'DEDUPED' as const,
                message: 'same logical fire',
                dedupIdentity: options.dedupIdentity,
              };
            }
            expect(options.codexRouting?.model).toBe('gpt-5.6-terra');
            sequenceStarts.push(content);
            if (failAfterFirstSequence) {
              failAfterFirstSequence = false;
              throw new Error('ambiguous failure after sequence admission');
            }
            return { ok: true as const };
          }),
        },
      };
      (am as unknown as { agents: Map<string, unknown> }).agents.set('alice', fakeEntry);
      const cron = {
        name: 'heartbeat',
        prompt: 'Read HEARTBEAT.md and follow its instructions. Update your heartbeat, check inbox, and work on your highest priority task.',
        schedule: '6h',
        enabled: true,
        created_at: '2026-08-05T00:00:00.000Z',
      };
      const admittedAt = '2026-08-05T01:00:00.000Z';
      const handleAgentCronFire = (am as unknown as {
        handleAgentCronFire: (agentName: string, definition: CronDefinition, context: CronFireContext) => Promise<void>;
      }).handleAgentCronFire.bind(am);

      const resultPromise = fireWithRetry(
        cron,
        'scheduled',
        admittedAt,
        'alice',
        async (definition, context) => {
          await handleAgentCronFire('alice', definition, context);
        },
        vi.fn(),
      );
      await vi.advanceTimersByTimeAsync(22_000);

      expect(await resultPromise).toBe(true);
      const attemptedIdentities = fakeEntry.process.injectMessageDetailed.mock.calls
        .map(([, options]) => options.dedupIdentity);
      expect(attemptedIdentities).toEqual([
        `daemon-cron:heartbeat:${admittedAt}`,
        `daemon-cron:heartbeat:${admittedAt}`,
      ]);
      expect(sequenceStarts).toHaveLength(1);
      expect(sequenceStarts[0]).toContain('[CRON PREFLIGHT] heartbeat');
    } finally {
      vi.useRealTimers();
    }
  });
});
