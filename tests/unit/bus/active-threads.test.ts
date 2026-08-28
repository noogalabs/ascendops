import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  addActiveThread,
  clearActiveThreads,
  listActiveThreads,
  removeActiveThread,
  resolveMeldIdsFromListOutput,
  updateActiveThread,
} from '../../../src/bus/active-threads';
import type { BusPaths } from '../../../src/types';

function makePaths(dir: string): BusPaths {
  return {
    ctxRoot: dir,
    inbox: join(dir, 'inbox', 'indigo'),
    inflight: join(dir, 'inflight', 'indigo'),
    processed: join(dir, 'processed', 'indigo'),
    logDir: join(dir, 'logs', 'indigo'),
    stateDir: join(dir, 'state', 'indigo'),
    taskDir: join(dir, 'tasks'),
    approvalDir: join(dir, 'approvals'),
    analyticsDir: join(dir, 'analytics'),
    deliverablesDir: join(dir, 'deliverables'),
  };
}

describe('active-threads', () => {
  let testDir: string;
  let paths: BusPaths;

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), 'cortextos-active-threads-test-'));
    paths = makePaths(testDir);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(testDir, { recursive: true, force: true });
  });

  it('adds a new thread and creates the file with the correct shape', () => {
    const thread = addActiveThread(paths, {
      meldId: '12729045',
      subject: 'No Hot Water In Home',
      owner: 'indigo',
      status: 'waiting_on_vendor',
      lastAction: 'Sent schedule message to Stubblefield',
      nextTriggerAt: '2026-05-09T14:00:00Z',
      notes: 'Tenant says mornings are worst.',
    });

    const filePath = join(paths.stateDir, 'active-threads.json');
    expect(existsSync(filePath)).toBe(true);

    const state = JSON.parse(readFileSync(filePath, 'utf-8'));
    expect(state.version).toBe(1);
    expect(typeof state.updated_at).toBe('string');
    expect(state.threads).toHaveLength(1);
    expect(state.threads[0]).toEqual(thread);
    expect(thread.internal_id).toBe('12729045');
  });

  it('scrubs SSNs from connector free-text (subject/last_action/notes) at add + update', () => {
    addActiveThread(paths, {
      meldId: '12729045',
      subject: 'Verify tenant SSN 123-45-6789',
      owner: 'indigo',
      status: 'open',
      lastAction: 'Confirmed ssn 987654321 on file',
      notes: 'resident tax id: 123456789 pending',
    });
    updateActiveThread(paths, '12729045', { notes: 'updated note for 987-65-4321' });

    const state = JSON.parse(readFileSync(join(paths.stateDir, 'active-threads.json'), 'utf-8'));
    const t = state.threads[0];
    expect(t.subject).toBe('Verify tenant SSN [REDACTED-SSN]');
    expect(t.last_action).toBe('Confirmed ssn [REDACTED-SSN] on file');
    expect(t.notes).toBe('updated note for [REDACTED-SSN]');
    expect(JSON.stringify(state)).not.toContain('123-45-6789');
    expect(JSON.stringify(state)).not.toContain('123456789');
  });

  it('adds existing meld_id as an upsert instead of creating a duplicate', () => {
    addActiveThread(paths, {
      meldId: '12729045',
      subject: 'Old subject',
      owner: 'indigo',
      status: 'waiting_on_vendor',
      lastAction: 'Initial note',
      notes: 'first',
    });

    addActiveThread(paths, {
      meldId: '12729045',
      subject: 'No Hot Water In Home',
      owner: 'indigo',
      status: 'vendor_scheduled',
      lastAction: 'Vendor confirmed tomorrow morning',
      notes: 'updated',
    });

    const state = listActiveThreads(paths);
    expect(state.threads).toHaveLength(1);
    expect(state.threads[0].subject).toBe('No Hot Water In Home');
    expect(state.threads[0].status).toBe('vendor_scheduled');
    expect(state.threads[0].notes).toBe('updated');
  });

  it('errors when updating a non-existent thread', () => {
    expect(() => updateActiveThread(paths, 'missing', { status: 'done' })).toThrow(
      'Active thread missing not found',
    );
  });

  it('removes a thread and persists the remaining file', () => {
    addActiveThread(paths, {
      meldId: '12729045',
      subject: 'No Hot Water In Home',
      owner: 'indigo',
      status: 'waiting_on_vendor',
      lastAction: 'Sent schedule message to Stubblefield',
    });

    addActiveThread(paths, {
      meldId: '12729046',
      subject: 'Leaking Faucet',
      owner: 'indigo',
      status: 'waiting_on_tenant',
      lastAction: 'Asked for access window',
    });

    removeActiveThread(paths, '12729045');
    const state = listActiveThreads(paths);
    expect(state.threads).toHaveLength(1);
    expect(state.threads[0].internal_id).toBe('12729046');
    expect(existsSync(join(paths.stateDir, 'active-threads.json'))).toBe(true);
  });

  it('clear empties the threads array and keeps the file', () => {
    addActiveThread(paths, {
      meldId: '12729045',
      subject: 'No Hot Water In Home',
      owner: 'indigo',
      status: 'waiting_on_vendor',
      lastAction: 'Sent schedule message to Stubblefield',
    });

    const removed = clearActiveThreads(paths);
    expect(removed).toBe(1);

    const filePath = join(paths.stateDir, 'active-threads.json');
    const state = JSON.parse(readFileSync(filePath, 'utf-8'));
    expect(state.threads).toEqual([]);
    expect(state.version).toBe(1);
  });

  it('keeps the file parseable under concurrent mutation', async () => {
    await Promise.all(
      Array.from({ length: 24 }, (_, i) => Promise.resolve().then(() => {
        addActiveThread(paths, {
          meldId: String(12729045 + i),
          subject: `Work order ${i}`,
          owner: 'indigo',
          status: 'open',
          lastAction: `action ${i}`,
        });
      })),
    );

    const filePath = join(paths.stateDir, 'active-threads.json');
    const parsed = JSON.parse(readFileSync(filePath, 'utf-8'));
    expect(parsed.version).toBe(1);
    expect(Array.isArray(parsed.threads)).toBe(true);
    expect(parsed.threads).toHaveLength(24);
  });

  it('resolves a ref_id through pm work-orders list output', () => {
    expect(resolveMeldIdsFromListOutput('T2C5NXAB', JSON.stringify([
      { ref_id: 'T2C5NXAB', id: 12729045, subject: 'No Hot Water In Home' },
    ]))).toEqual({
      meldId: 'T2C5NXAB',
      internalId: '12729045',
    });
  });
});
