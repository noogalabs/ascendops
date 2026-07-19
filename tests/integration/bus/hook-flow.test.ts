// Integration coverage for hook telemetry: dispatchHook → handler result → bus log-event subprocess.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import type { Event } from '../../../src/types/index';

const execFileCalls: Array<{ cmd: string; args: string[] }> = [];
vi.mock('child_process', () => ({
  execFile: (cmd: string, args: string[], _opts: unknown, cb?: () => void) => {
    execFileCalls.push({ cmd, args: [...args] });
    if (typeof cb === 'function') cb();
    return { unref: () => {} };
  },
}));

import {
  clearHandlerRegistry,
  dispatchHook,
  loadHookRegistry,
  matchHooks,
  registerHandler,
  type HookEntry,
  type HandlerResult,
} from '../../../src/bus/hooks';

function makeEvent(overrides: Partial<Event> = {}): Event {
  return {
    id: 'evt-1',
    agent: 'collie',
    org: 'ascendops',
    timestamp: '2026-04-29T20:00:00Z',
    category: 'action',
    event: 'pm_meld_completed',
    severity: 'info',
    metadata: {},
    ...overrides,
  };
}

function makeHook(overrides: Partial<HookEntry> = {}): HookEntry {
  return {
    id: 'h1',
    event_pattern: { category: 'action', type: 'pm_meld_completed' },
    handler_type: 'log_event',
    handler: { category: 'action', type: 'demo', severity: 'info', meta: {} },
    agent_filter: [],
    priority: 100,
    enabled: true,
    ...overrides,
  };
}

function lastEmittedEvent(): { name: string; meta: Record<string, unknown> } | null {
  if (execFileCalls.length === 0) return null;
  const args = execFileCalls[execFileCalls.length - 1].args;
  const name = args[3];
  const metaIdx = args.indexOf('--meta');
  const meta = metaIdx >= 0 && metaIdx + 1 < args.length ? JSON.parse(args[metaIdx + 1]) : {};
  return { name, meta };
}

describe('hook telemetry — end-to-end flow', () => {
  const originalFrameworkRoot = process.env.CTX_FRAMEWORK_ROOT;

  beforeEach(() => {
    execFileCalls.length = 0;
    clearHandlerRegistry();
    delete process.env.CTX_FRAMEWORK_ROOT;
  });

  afterEach(() => {
    if (originalFrameworkRoot === undefined) delete process.env.CTX_FRAMEWORK_ROOT;
    else process.env.CTX_FRAMEWORK_ROOT = originalFrameworkRoot;
  });

  it('routes fire results to the cortextos bus log-event subprocess', async () => {
    registerHandler('log_event', (): HandlerResult => ({
      action: 'fire',
      reason: 'ran',
      meta: { processed_meld_id: 12345 },
    }));

    await dispatchHook(makeHook(), makeEvent());

    expect(execFileCalls).toHaveLength(1);
    expect(execFileCalls[0].cmd).toBe('cortextos');
    expect(execFileCalls[0].args[0]).toBe('bus');
    expect(execFileCalls[0].args[1]).toBe('log-event');
    expect(execFileCalls[0].args[2]).toBe('action');
    expect(execFileCalls[0].args[3]).toBe('hook_fire');
    const emitted = lastEmittedEvent();
    expect(emitted?.meta.outcome).toBe('ran');
    expect(emitted?.meta.processed_meld_id).toBe(12345);
    expect(emitted?.meta.hook_id).toBe('h1');
    expect(emitted?.meta.handler_type).toBe('log_event');
    expect(emitted?.meta.event_id).toBe('evt-1');
  });

  it('uses the framework CLI through the current Node executable when CTX_FRAMEWORK_ROOT is set', async () => {
    process.env.CTX_FRAMEWORK_ROOT = '/opt/cortextos';
    registerHandler('log_event', (): HandlerResult => ({ action: 'fire', reason: 'ran' }));

    await dispatchHook(makeHook(), makeEvent());

    expect(execFileCalls).toHaveLength(1);
    expect(execFileCalls[0].cmd).toBe(process.execPath);
    expect(execFileCalls[0].args.slice(0, 3)).toEqual([
      join('/opt/cortextos', 'dist', 'cli.js'),
      'bus',
      'log-event',
    ]);
  });

  it('routes block results to hook_block', async () => {
    registerHandler('log_event', (): HandlerResult => ({
      action: 'block',
      reason: 'guard_blocked',
    }));

    await dispatchHook(makeHook(), makeEvent());

    const emitted = lastEmittedEvent();
    expect(execFileCalls).toHaveLength(1);
    expect(emitted?.name).toBe('hook_block');
    expect(emitted?.meta.outcome).toBe('guard_blocked');
  });

  it('routes escalate results to hook_escalate', async () => {
    registerHandler('log_event', (): HandlerResult => ({
      action: 'escalate',
      reason: 'severity_bumped',
    }));

    await dispatchHook(makeHook(), makeEvent());

    const emitted = lastEmittedEvent();
    expect(execFileCalls).toHaveLength(1);
    expect(emitted?.name).toBe('hook_escalate');
    expect(emitted?.meta.outcome).toBe('severity_bumped');
  });

  it('treats a thrown handler as hook_block with handler_threw outcome text', async () => {
    registerHandler('log_event', () => {
      throw new Error('boom');
    });

    await dispatchHook(makeHook(), makeEvent());

    const emitted = lastEmittedEvent();
    expect(execFileCalls).toHaveLength(1);
    expect(emitted?.name).toBe('hook_block');
    expect(String(emitted?.meta.outcome)).toContain('handler_threw');
    expect(String(emitted?.meta.outcome)).toContain('boom');
  });

  it('awaits async handlers before choosing the bus event name', async () => {
    registerHandler('log_event', async (): Promise<HandlerResult> => {
      await new Promise((resolve) => setTimeout(resolve, 1));
      return { action: 'block', reason: 'async_block' };
    });

    await dispatchHook(makeHook(), makeEvent());

    const emitted = lastEmittedEvent();
    expect(execFileCalls).toHaveLength(1);
    expect(emitted?.name).toBe('hook_block');
    expect(emitted?.meta.outcome).toBe('async_block');
  });

  it.each([
    {
      name: 'fire',
      setup: () => registerHandler('log_event', (): HandlerResult => ({ action: 'fire', reason: 'ran' })),
    },
    {
      name: 'block',
      setup: () => registerHandler('log_event', (): HandlerResult => ({ action: 'block', reason: 'blocked' })),
    },
    {
      name: 'escalate',
      setup: () => registerHandler('log_event', (): HandlerResult => ({ action: 'escalate', reason: 'escalated' })),
    },
    {
      name: 'throw',
      setup: () => registerHandler('log_event', () => { throw new Error('boom'); }),
    },
    {
      name: 'async',
      setup: () => registerHandler('log_event', async (): Promise<HandlerResult> => {
        await new Promise((resolve) => setTimeout(resolve, 1));
        return { action: 'block', reason: 'async_block' };
      }),
    },
    {
      name: 'no_handler_registered',
      setup: () => {},
    },
    {
      name: 'undefined_return',
      setup: () => registerHandler('log_event', () => undefined),
    },
  ])('emits exactly one bus event per dispatch attempt: $name', async ({ setup }) => {
    setup();

    await dispatchHook(makeHook(), makeEvent());

    expect(execFileCalls).toHaveLength(1);
  });

  it('does not emit when matchHooks returns no matches from an empty registry', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'cx-hook-flow-'));
    try {
      const registry = loadHookRegistry(tmp);
      expect(registry.hooks).toEqual([]);
      expect(matchHooks(registry, makeEvent(), 'collie')).toEqual([]);
      expect(execFileCalls).toHaveLength(0);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('emits hook_fire with implicit_default when the handler returns undefined', async () => {
    registerHandler('log_event', () => undefined);

    await dispatchHook(makeHook(), makeEvent());

    const emitted = lastEmittedEvent();
    expect(execFileCalls).toHaveLength(1);
    expect(emitted?.name).toBe('hook_fire');
    expect(emitted?.meta.outcome).toBe('implicit_default');
  });

  it('emits hook_fire with no_handler_registered when no handler is registered', async () => {
    await dispatchHook(makeHook(), makeEvent());

    const emitted = lastEmittedEvent();
    expect(execFileCalls).toHaveLength(1);
    expect(emitted?.name).toBe('hook_fire');
    expect(emitted?.meta.outcome).toBe('no_handler_registered');
  });
});
