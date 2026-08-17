import { existsSync, readFileSync } from 'fs';
import { atomicWriteSync } from '../utils/atomic.js';

export interface CustodiedTurn {
  workItemId: string;
  threadId: string;
  input: unknown[];
  deferredSkill?: string;
  routing?: unknown;
  cronSequence?: unknown;
  admittedAt: string;
  startAttempts: number;
}

interface TurnCustodyFile {
  version: 1;
  pending: CustodiedTurn[];
}

/**
 * Crash-safe local custody for app-server turns.
 *
 * Mutations are written atomically before the in-memory view changes. A failed
 * write therefore cannot make the running adapter believe it owns a state that
 * a restarted adapter cannot recover.
 */
export class CodexTurnCustodyStore {
  private pending: CustodiedTurn[] = [];

  constructor(private readonly path: string) {}

  load(): CustodiedTurn[] {
    if (!existsSync(this.path)) {
      this.pending = [];
      return [];
    }

    const parsed = JSON.parse(readFileSync(this.path, 'utf-8')) as unknown;
    if (!isRecord(parsed) || parsed.version !== 1 || !Array.isArray(parsed.pending)) {
      throw new Error('expected version 1 turn-custody object with pending[]');
    }

    const ids = new Set<string>();
    const pending = parsed.pending.map((candidate) => {
      if (!isRecord(candidate) ||
          typeof candidate.workItemId !== 'string' ||
          candidate.workItemId.length === 0 ||
          typeof candidate.threadId !== 'string' ||
          candidate.threadId.length === 0 ||
          !Array.isArray(candidate.input) ||
          (candidate.deferredSkill !== undefined &&
            (typeof candidate.deferredSkill !== 'string' || candidate.deferredSkill.length === 0)) ||
          typeof candidate.admittedAt !== 'string' ||
          !Number.isSafeInteger(candidate.startAttempts) ||
          (candidate.startAttempts as number) < 0 ||
          (candidate.deferredSkill !== undefined && candidate.startAttempts !== 0)) {
        throw new Error('invalid pending turn-custody record');
      }
      if (ids.has(candidate.workItemId)) {
        throw new Error(`duplicate turn-custody work item ${candidate.workItemId}`);
      }
      ids.add(candidate.workItemId);
      return {
        workItemId: candidate.workItemId,
        threadId: candidate.threadId,
        input: candidate.input,
        ...(candidate.deferredSkill === undefined ? {} : { deferredSkill: candidate.deferredSkill }),
        ...(candidate.routing === undefined ? {} : { routing: candidate.routing }),
        ...(candidate.cronSequence === undefined ? {} : { cronSequence: candidate.cronSequence }),
        admittedAt: candidate.admittedAt,
        startAttempts: candidate.startAttempts as number,
      } satisfies CustodiedTurn;
    });

    this.pending = pending;
    return this.snapshot();
  }

  snapshot(): CustodiedTurn[] {
    return this.pending.map(cloneTurn);
  }

  admit(turn: CustodiedTurn, position: 'front' | 'back' = 'back'): void {
    if (this.pending.some((candidate) => candidate.workItemId === turn.workItemId)) {
      throw new Error(`turn-custody work item already admitted: ${turn.workItemId}`);
    }
    const cloned = cloneTurn(turn);
    const next = position === 'front'
      ? [cloned, ...this.pending]
      : [...this.pending, cloned];
    this.write(next);
    this.pending = next;
  }

  noteStartAttempt(workItemId: string): number {
    const index = this.pending.findIndex((candidate) => candidate.workItemId === workItemId);
    if (index < 0) throw new Error(`turn-custody work item is not pending: ${workItemId}`);
    const next = this.snapshot();
    next[index] = {
      ...next[index],
      startAttempts: next[index].startAttempts + 1,
    };
    this.write(next);
    this.pending = next;
    return next[index].startAttempts;
  }

  resolveDeferredSkill(workItemId: string, input: unknown[]): void {
    const index = this.pending.findIndex((candidate) => candidate.workItemId === workItemId);
    if (index < 0) throw new Error(`turn-custody work item is not pending: ${workItemId}`);
    if (this.pending[index].deferredSkill === undefined) {
      throw new Error(`turn-custody work item has no deferred skill: ${workItemId}`);
    }
    const next = this.snapshot();
    const { deferredSkill: _deferredSkill, ...pending } = next[index];
    next[index] = {
      ...pending,
      input: structuredClone(input),
    };
    this.write(next);
    this.pending = next;
  }

  settle(workItemId: string): void {
    if (!this.pending.some((candidate) => candidate.workItemId === workItemId)) {
      throw new Error(`turn-custody work item is not pending: ${workItemId}`);
    }
    const next = this.pending
      .filter((candidate) => candidate.workItemId !== workItemId)
      .map(cloneTurn);
    this.write(next);
    this.pending = next;
  }

  replace(
    workItemId: string,
    successor: CustodiedTurn,
    position: 'front' | 'back' = 'front',
  ): void {
    if (!this.pending.some((candidate) => candidate.workItemId === workItemId)) {
      throw new Error(`turn-custody work item is not pending: ${workItemId}`);
    }
    if (this.pending.some((candidate) =>
      candidate.workItemId !== workItemId && candidate.workItemId === successor.workItemId)) {
      throw new Error(`turn-custody work item already admitted: ${successor.workItemId}`);
    }
    const remaining = this.pending
      .filter((candidate) => candidate.workItemId !== workItemId)
      .map(cloneTurn);
    const cloned = cloneTurn(successor);
    const next = position === 'front'
      ? [cloned, ...remaining]
      : [...remaining, cloned];
    this.write(next);
    this.pending = next;
  }

  private write(pending: CustodiedTurn[]): void {
    const state: TurnCustodyFile = { version: 1, pending };
    atomicWriteSync(this.path, JSON.stringify(state, null, 2));
  }
}

function cloneTurn(turn: CustodiedTurn): CustodiedTurn {
  return {
    workItemId: turn.workItemId,
    threadId: turn.threadId,
    input: structuredClone(turn.input),
    ...(turn.deferredSkill === undefined ? {} : { deferredSkill: turn.deferredSkill }),
    ...(turn.routing === undefined ? {} : { routing: structuredClone(turn.routing) }),
    ...(turn.cronSequence === undefined ? {} : { cronSequence: structuredClone(turn.cronSequence) }),
    admittedAt: turn.admittedAt,
    startAttempts: turn.startAttempts,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
