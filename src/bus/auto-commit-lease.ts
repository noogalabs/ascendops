import { randomUUID } from 'crypto';
import { existsSync, readFileSync, rmSync } from 'fs';
import { join } from 'path';
import { atomicWriteSync, ensureDir } from '../utils/atomic.js';
import { withFileLockSync } from '../utils/lock.js';

export const DEFAULT_AUTO_COMMIT_LEASE_TTL_MS = 10 * 60_000;
export const MIN_AUTO_COMMIT_LEASE_TTL_MS = 5 * 60_000;
export const MAX_AUTO_COMMIT_LEASE_TTL_MS = 60 * 60_000;
export const AUTO_COMMIT_PRE_COMMIT_MARGIN_MS = 60_000;

export interface AutoCommitLeaseHolder {
  org: string;
  agent: string;
}

export interface AutoCommitLease {
  holder: AutoCommitLeaseHolder;
  token: string;
  acquired_at: number;
  expires_at: number;
}

interface StoredAutoCommitLease extends AutoCommitLease {
  version: 1;
}

export type AutoCommitLeaseAcquireResult =
  | {
    status: 'acquired';
    lease: AutoCommitLease;
    takeover?: {
      previous_holder: AutoCommitLeaseHolder;
      previous_expires_at: number;
    };
  }
  | { status: 'contended'; holder: AutoCommitLeaseHolder; expires_at: number }
  | { status: 'error'; error: string };

export type AutoCommitLeaseStatus =
  | { status: 'none' }
  | {
    status: 'active' | 'expired';
    holder: AutoCommitLeaseHolder;
    acquired_at: number;
    expires_at: number;
  }
  | { status: 'error'; error: string };

export type AutoCommitLeaseReleaseResult =
  | { status: 'released'; holder: AutoCommitLeaseHolder; released_at: number }
  | {
    status: 'error';
    error: string;
    holder?: AutoCommitLeaseHolder;
    expires_at?: number;
  };

export type AutoCommitLeaseAssertionResult =
  | {
    status: 'held';
    holder: AutoCommitLeaseHolder;
    expires_at: number;
    remaining_ms: number;
  }
  | {
    status: 'error';
    error: string;
    holder?: AutoCommitLeaseHolder;
    expires_at?: number;
    remaining_ms?: number;
  };

export interface AcquireAutoCommitLeaseOptions {
  ctxRoot: string;
  holder: AutoCommitLeaseHolder;
  now?: number;
  ttlMs?: number;
  /** Deterministic token injection for tests. */
  token?: string;
}

export interface ReleaseAutoCommitLeaseOptions {
  ctxRoot: string;
  token: string;
  now?: number;
}

export function autoCommitLeasePath(ctxRoot: string): string {
  return join(ctxRoot, 'state', 'auto-commit-lease.json');
}

export function resolveAutoCommitLeaseTtlMs(agentDir: string): number {
  const configPath = join(agentDir, 'config.json');
  if (!existsSync(configPath)) return DEFAULT_AUTO_COMMIT_LEASE_TTL_MS;
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(configPath, 'utf-8'));
  } catch {
    throw new Error(`could not read auto-commit lease configuration from ${configPath}`);
  }
  const ttl = (parsed as {
    ecosystem?: { local_version_control?: { lease_ttl_ms?: unknown } };
  })?.ecosystem?.local_version_control?.lease_ttl_ms;
  if (ttl === undefined) return DEFAULT_AUTO_COMMIT_LEASE_TTL_MS;
  if (!isValidLeaseTtl(ttl)) {
    throw new Error(
      `ecosystem.local_version_control.lease_ttl_ms must be an integer between ${MIN_AUTO_COMMIT_LEASE_TTL_MS} and ${MAX_AUTO_COMMIT_LEASE_TTL_MS} milliseconds`,
    );
  }
  return ttl as number;
}

function leaseMutationLockRoot(ctxRoot: string): string {
  return join(ctxRoot, 'state', '.auto-commit-lease-mutation');
}

export function acquireAutoCommitLease(
  options: AcquireAutoCommitLeaseOptions,
): AutoCommitLeaseAcquireResult {
  const now = options.now ?? Date.now();
  const ttlMs = options.ttlMs ?? DEFAULT_AUTO_COMMIT_LEASE_TTL_MS;
  if (!isValidLeaseTtl(ttlMs)) {
    return {
      status: 'error',
      error: `auto-commit lease TTL must be an integer between ${MIN_AUTO_COMMIT_LEASE_TTL_MS} and ${MAX_AUTO_COMMIT_LEASE_TTL_MS} milliseconds`,
    };
  }

  const lockRoot = leaseMutationLockRoot(options.ctxRoot);
  ensureDir(lockRoot);

  try {
    return withFileLockSync(lockRoot, () => {
      const state = readStoredLease(autoCommitLeasePath(options.ctxRoot));
      if (state.status === 'error') return state;

      if (state.lease && state.lease.expires_at > now) {
        return {
          status: 'contended' as const,
          holder: state.lease.holder,
          expires_at: state.lease.expires_at,
        };
      }

      const lease: AutoCommitLease = {
        holder: options.holder,
        token: options.token ?? randomUUID(),
        acquired_at: now,
        expires_at: now + ttlMs,
      };
      const stored: StoredAutoCommitLease = { version: 1, ...lease };
      atomicWriteSync(autoCommitLeasePath(options.ctxRoot), JSON.stringify(stored, null, 2));

      if (!state.lease) return { status: 'acquired' as const, lease };
      return {
        status: 'acquired' as const,
        lease,
        takeover: {
          previous_holder: state.lease.holder,
          previous_expires_at: state.lease.expires_at,
        },
      };
    });
  } catch {
    return { status: 'error', error: 'auto-commit lease state could not be updated' };
  }
}

export function releaseAutoCommitLease(
  options: ReleaseAutoCommitLeaseOptions,
): AutoCommitLeaseReleaseResult {
  const now = options.now ?? Date.now();
  const lockRoot = leaseMutationLockRoot(options.ctxRoot);
  ensureDir(lockRoot);

  try {
    return withFileLockSync(lockRoot, () => {
      const state = readStoredLease(autoCommitLeasePath(options.ctxRoot));
      if (state.status === 'error') return state;
      if (!state.lease) {
        return { status: 'error' as const, error: 'no auto-commit lease is active' };
      }
      if (state.lease.token !== options.token) {
        return {
          status: 'error' as const,
          error: 'auto-commit lease token does not match the active holder',
          holder: state.lease.holder,
          expires_at: state.lease.expires_at,
        };
      }

      rmSync(autoCommitLeasePath(options.ctxRoot));
      return {
        status: 'released' as const,
        holder: state.lease.holder,
        released_at: now,
      };
    });
  } catch {
    return { status: 'error', error: 'auto-commit lease state could not be updated' };
  }
}

export function getAutoCommitLeaseStatus(
  ctxRoot: string,
  now: number = Date.now(),
): AutoCommitLeaseStatus {
  const state = readStoredLease(autoCommitLeasePath(ctxRoot));
  if (state.status === 'error') return state;
  if (!state.lease) return { status: 'none' };
  return {
    status: state.lease.expires_at <= now ? 'expired' : 'active',
    holder: state.lease.holder,
    acquired_at: state.lease.acquired_at,
    expires_at: state.lease.expires_at,
  };
}

export function assertAutoCommitLeaseHeld(
  ctxRoot: string,
  token: string,
  now: number = Date.now(),
): AutoCommitLeaseAssertionResult {
  const state = readStoredLease(autoCommitLeasePath(ctxRoot));
  if (state.status === 'error') return state;
  if (!state.lease) {
    return { status: 'error', error: 'no auto-commit lease is active' };
  }
  if (state.lease.token !== token) {
    return {
      status: 'error',
      error: 'auto-commit lease token does not match the active holder',
      holder: state.lease.holder,
      expires_at: state.lease.expires_at,
    };
  }
  const remainingMs = state.lease.expires_at - now;
  if (remainingMs < AUTO_COMMIT_PRE_COMMIT_MARGIN_MS) {
    return {
      status: 'error',
      error: `auto-commit lease has ${remainingMs}ms remaining; at least ${AUTO_COMMIT_PRE_COMMIT_MARGIN_MS}ms is required before commit`,
      holder: state.lease.holder,
      expires_at: state.lease.expires_at,
      remaining_ms: remainingMs,
    };
  }
  return {
    status: 'held',
    holder: state.lease.holder,
    expires_at: state.lease.expires_at,
    remaining_ms: remainingMs,
  };
}

function readStoredLease(path: string):
  | { status: 'ok'; lease: StoredAutoCommitLease | null }
  | { status: 'error'; error: string } {
  if (!existsSync(path)) return { status: 'ok', lease: null };
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf-8')) as unknown;
    if (!isStoredLease(parsed)) throw new Error('invalid lease shape');
    return { status: 'ok', lease: parsed };
  } catch {
    return { status: 'error', error: 'auto-commit lease state is unreadable; refusing operation' };
  }
}

function isStoredLease(value: unknown): value is StoredAutoCommitLease {
  if (!value || typeof value !== 'object') return false;
  const lease = value as Partial<StoredAutoCommitLease>;
  return lease.version === 1
    && typeof lease.token === 'string'
    && lease.token.length > 0
    && Number.isSafeInteger(lease.acquired_at)
    && Number.isSafeInteger(lease.expires_at)
    && !!lease.holder
    && typeof lease.holder.org === 'string'
    && typeof lease.holder.agent === 'string';
}

function isValidLeaseTtl(value: unknown): value is number {
  return Number.isSafeInteger(value)
    && (value as number) >= MIN_AUTO_COMMIT_LEASE_TTL_MS
    && (value as number) <= MAX_AUTO_COMMIT_LEASE_TTL_MS;
}
