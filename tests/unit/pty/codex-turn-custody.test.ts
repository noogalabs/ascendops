import { mkdtempSync, readFileSync, statSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { describe, expect, it } from 'vitest';
import { CodexTurnCustodyStore, type CustodiedTurn } from '../../../src/pty/codex-turn-custody.js';

function turn(workItemId: string): CustodiedTurn {
  return {
    workItemId,
    threadId: 'thread-1',
    input: [{ type: 'text', text: workItemId }],
    admittedAt: '2026-08-13T20:00:00.000Z',
    startAttempts: 0,
  };
}

function deferredTurn(workItemId: string): CustodiedTurn {
  return {
    ...turn(workItemId),
    input: [],
    deferredSkill: '$heartbeat run now',
  };
}

describe('CodexTurnCustodyStore', () => {
  it('durably restores admitted work and its start-attempt count', () => {
    const root = mkdtempSync(join(tmpdir(), 'codex-turn-custody-'));
    const path = join(root, 'custody.json');
    const first = new CodexTurnCustodyStore(path);

    first.load();
    first.admit(turn('work-a'));
    expect(first.noteStartAttempt('work-a')).toBe(1);

    const restarted = new CodexTurnCustodyStore(path);
    expect(restarted.load()).toEqual([{
      ...turn('work-a'),
      startAttempts: 1,
    }]);
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  it('writes an empty tombstone before forgetting a settled work item', () => {
    const root = mkdtempSync(join(tmpdir(), 'codex-turn-custody-'));
    const path = join(root, 'custody.json');
    const store = new CodexTurnCustodyStore(path);
    store.load();
    store.admit(turn('work-a'));
    store.settle('work-a');

    expect(JSON.parse(readFileSync(path, 'utf-8'))).toEqual({ version: 1, pending: [] });
    expect(new CodexTurnCustodyStore(path).load()).toEqual([]);
  });

  it('atomically replaces a completed phase with its durable successor', () => {
    const root = mkdtempSync(join(tmpdir(), 'codex-turn-custody-'));
    const path = join(root, 'custody.json');
    const store = new CodexTurnCustodyStore(path);
    store.load();
    store.admit(turn('preflight'));
    store.admit(turn('already-queued'));
    store.replace('preflight', turn('continuation'), 'front');

    expect(store.snapshot().map((record) => record.workItemId))
      .toEqual(['continuation', 'already-queued']);
    expect(new CodexTurnCustodyStore(path).load().map((record) => record.workItemId))
      .toEqual(['continuation', 'already-queued']);
  });

  it('restores unresolved skill intent and atomically binds its resolved input', () => {
    const root = mkdtempSync(join(tmpdir(), 'codex-turn-custody-'));
    const path = join(root, 'custody.json');
    const first = new CodexTurnCustodyStore(path);
    first.load();
    first.admit(deferredTurn('skill-work'));

    const restarted = new CodexTurnCustodyStore(path);
    expect(restarted.load()).toEqual([deferredTurn('skill-work')]);
    restarted.resolveDeferredSkill('skill-work', [
      { type: 'skill', name: 'heartbeat', path: '/skills/heartbeat/SKILL.md' },
      { type: 'text', text: 'run now', text_elements: [] },
    ]);

    expect(new CodexTurnCustodyStore(path).load()).toEqual([{
      ...turn('skill-work'),
      input: [
        { type: 'skill', name: 'heartbeat', path: '/skills/heartbeat/SKILL.md' },
        { type: 'text', text: 'run now', text_elements: [] },
      ],
    }]);
  });

  it('fails closed on duplicate or malformed persisted identities', () => {
    const root = mkdtempSync(join(tmpdir(), 'codex-turn-custody-'));
    const path = join(root, 'custody.json');
    writeFileSync(path, JSON.stringify({ version: 1, pending: [turn('same'), turn('same')] }));
    expect(() => new CodexTurnCustodyStore(path).load()).toThrow(/duplicate turn-custody work item/);

    writeFileSync(path, JSON.stringify({ version: 1, pending: [{ workItemId: 'x' }] }));
    expect(() => new CodexTurnCustodyStore(path).load()).toThrow(/invalid pending turn-custody record/);

    writeFileSync(path, JSON.stringify({
      version: 1,
      pending: [{ ...deferredTurn('started-deferred'), startAttempts: 1 }],
    }));
    expect(() => new CodexTurnCustodyStore(path).load()).toThrow(/invalid pending turn-custody record/);
  });
});
