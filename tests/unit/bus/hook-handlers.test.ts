import { afterEach, describe, it, expect, beforeEach, vi } from 'vitest';
import { join } from 'path';
import type { Event } from '../../../src/types/index';

const execFileCalls: Array<{ cmd: string; args: string[] }> = [];
let execFileImpl = (cmd: string, args: string[], _opts: unknown, cb?: () => void) => {
  execFileCalls.push({ cmd, args: [...args] });
  if (typeof cb === 'function') cb();
  return { unref: () => {} };
};

vi.mock('child_process', () => ({
  execFile: (cmd: string, args: string[], opts: unknown, cb?: () => void) =>
    execFileImpl(cmd, args, opts, cb),
}));

import { clearHandlerRegistry, _getRegisteredHandler, type HookEntry } from '../../../src/bus/hooks';
import { BUILT_IN_HANDLERS, registerBuiltInHandlers } from '../../../src/bus/hook-handlers';
import { logEventHandler } from '../../../src/bus/hook-handlers/log_event';
import { bashSpawnHandler } from '../../../src/bus/hook-handlers/bash_spawn';
import { sendMessageHandler } from '../../../src/bus/hook-handlers/send_message';
import { webhookFetchHandler } from '../../../src/bus/hook-handlers/webhook_fetch';

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

describe('src/bus/hook-handlers', () => {
  const originalFrameworkRoot = process.env.CTX_FRAMEWORK_ROOT;

  beforeEach(() => {
    execFileCalls.length = 0;
    execFileImpl = (cmd: string, args: string[], _opts: unknown, cb?: () => void) => {
      execFileCalls.push({ cmd, args: [...args] });
      if (typeof cb === 'function') cb();
      return { unref: () => {} };
    };
    clearHandlerRegistry();
    delete process.env.CTX_FRAMEWORK_ROOT;
  });

  afterEach(() => {
    if (originalFrameworkRoot === undefined) delete process.env.CTX_FRAMEWORK_ROOT;
    else process.env.CTX_FRAMEWORK_ROOT = originalFrameworkRoot;
  });

  it('registerBuiltInHandlers registers all four handler types', () => {
    expect(registerBuiltInHandlers()).toBe(4);
    expect(_getRegisteredHandler('log_event')).toBeTruthy();
    expect(_getRegisteredHandler('bash')).toBeTruthy();
    expect(_getRegisteredHandler('send_message')).toBeTruthy();
    expect(_getRegisteredHandler('webhook')).toBeTruthy();
  });

  it('BUILT_IN_HANDLERS has exactly the expected keys', () => {
    expect(Object.keys(BUILT_IN_HANDLERS).sort()).toEqual(['bash', 'log_event', 'send_message', 'webhook']);
  });

  it('logEventHandler fires one cortextos bus log-event call with source ids in meta', async () => {
    const result = await logEventHandler(makeHook(), makeEvent());
    expect(result).toEqual({ action: 'fire', reason: 'event_logged' });
    expect(execFileCalls).toHaveLength(1);
    expect(execFileCalls[0].cmd).toBe('cortextos');
    expect(execFileCalls[0].args[0]).toBe('bus');
    expect(execFileCalls[0].args[1]).toBe('log-event');
    const meta = JSON.parse(execFileCalls[0].args[6]);
    expect(meta.source_hook_id).toBe('h1');
    expect(meta.source_event_id).toBe('evt-1');
  });

  it('logEventHandler uses the framework CLI through the current Node executable when CTX_FRAMEWORK_ROOT is set', async () => {
    process.env.CTX_FRAMEWORK_ROOT = '/opt/cortextos';

    await logEventHandler(makeHook(), makeEvent());

    expect(execFileCalls).toHaveLength(1);
    expect(execFileCalls[0].cmd).toBe(process.execPath);
    expect(execFileCalls[0].args.slice(0, 3)).toEqual([
      join('/opt/cortextos', 'dist', 'cli.js'),
      'bus',
      'log-event',
    ]);
  });

  it('logEventHandler uses provided routing values and documented defaults', async () => {
    await logEventHandler(
      makeHook({ handler: { category: 'error', type: 'custom_type', severity: 'critical', meta: { a: 1 } } }),
      makeEvent(),
    );
    expect(execFileCalls[0].args.slice(2, 5)).toEqual(['error', 'custom_type', 'critical']);
    execFileCalls.length = 0;
    await logEventHandler(makeHook({ handler: {} }), makeEvent());
    expect(execFileCalls[0].args.slice(2, 5)).toEqual(['action', 'hook_handler_log_event', 'info']);
  });

  it('logEventHandler is best-effort if execFile throws synchronously', async () => {
    execFileImpl = () => {
      throw new Error('spawn failed');
    };
    expect(logEventHandler(makeHook(), makeEvent())).toEqual({
      action: 'fire',
      reason: 'event_logged',
    });
  });

  it('scaffold handlers return fire/not_implemented (no throw)', () => {
    expect(bashSpawnHandler(makeHook(), makeEvent())).toEqual({ action: 'fire', reason: 'not_implemented' });
    expect(sendMessageHandler(makeHook(), makeEvent())).toEqual({ action: 'fire', reason: 'not_implemented' });
    expect(webhookFetchHandler(makeHook(), makeEvent())).toEqual({ action: 'fire', reason: 'not_implemented' });
  });
});
