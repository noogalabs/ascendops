import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  acquireAutoCommitLease,
  assertAutoCommitLeaseHeld,
  AUTO_COMMIT_PRE_COMMIT_MARGIN_MS,
  autoCommitLeasePath,
  getAutoCommitLeaseStatus,
  releaseAutoCommitLease,
  resolveAutoCommitLeaseTtlMs,
  MAX_AUTO_COMMIT_LEASE_TTL_MS,
  MIN_AUTO_COMMIT_LEASE_TTL_MS,
} from '../../../src/bus/auto-commit-lease.js';

describe('auto-commit single-writer lease', () => {
  let ctxRoot: string;
  const holderA = { org: 'acme', agent: 'alice' };
  const holderB = { org: 'acme', agent: 'bob' };

  beforeEach(() => {
    ctxRoot = mkdtempSync(join(tmpdir(), 'auto-commit-lease-'));
  });

  afterEach(() => {
    rmSync(ctxRoot, { recursive: true, force: true });
  });

  it('acquires before work and exposes a read-only active status', () => {
    const result = acquireAutoCommitLease({
      ctxRoot,
      holder: holderA,
      now: 1_000,
      ttlMs: 600_000,
      token: 'token-a',
    });

    expect(result).toEqual({
      status: 'acquired',
      lease: {
        holder: holderA,
        token: 'token-a',
        acquired_at: 1_000,
        expires_at: 601_000,
      },
    });
    expect(getAutoCommitLeaseStatus(ctxRoot, 2_000)).toEqual({
      status: 'active',
      holder: holderA,
      acquired_at: 1_000,
      expires_at: 601_000,
    });
  });

  it('refuses immediately with holder and expiry while a crashed holder lease is valid', () => {
    acquireAutoCommitLease({ ctxRoot, holder: holderA, now: 1_000, ttlMs: 600_000, token: 'token-a' });

    expect(acquireAutoCommitLease({
      ctxRoot,
      holder: holderB,
      now: 2_000,
      ttlMs: 600_000,
      token: 'token-b',
    })).toEqual({
      status: 'contended',
      holder: holderA,
      expires_at: 601_000,
    });
  });

  it('takes over only after expiry and reports the previous owner for audit', () => {
    acquireAutoCommitLease({ ctxRoot, holder: holderA, now: 1_000, ttlMs: 600_000, token: 'token-a' });

    expect(acquireAutoCommitLease({
      ctxRoot,
      holder: holderB,
      now: 601_000,
      ttlMs: 600_000,
      token: 'token-b',
    })).toEqual({
      status: 'acquired',
      lease: {
        holder: holderB,
        token: 'token-b',
        acquired_at: 601_000,
        expires_at: 1_201_000,
      },
      takeover: {
        previous_holder: holderA,
        previous_expires_at: 601_000,
      },
    });
  });

  it('refuses wrong-token release and preserves the active lease', () => {
    acquireAutoCommitLease({ ctxRoot, holder: holderA, now: 1_000, ttlMs: 600_000, token: 'token-a' });

    expect(releaseAutoCommitLease({ ctxRoot, token: 'wrong-token', now: 2_000 })).toEqual({
      status: 'error',
      error: 'auto-commit lease token does not match the active holder',
      holder: holderA,
      expires_at: 601_000,
    });
    expect(getAutoCommitLeaseStatus(ctxRoot, 2_000).status).toBe('active');
  });

  it('asserts exact ownership with an inclusive fixed 60-second commit margin', () => {
    acquireAutoCommitLease({
      ctxRoot,
      holder: holderA,
      now: 1_000,
      ttlMs: MIN_AUTO_COMMIT_LEASE_TTL_MS,
      token: 'token-a',
    });
    const expiresAt = 301_000;

    expect(assertAutoCommitLeaseHeld(
      ctxRoot,
      'token-a',
      expiresAt - AUTO_COMMIT_PRE_COMMIT_MARGIN_MS,
    )).toEqual({
      status: 'held',
      holder: holderA,
      expires_at: expiresAt,
      remaining_ms: AUTO_COMMIT_PRE_COMMIT_MARGIN_MS,
    });
    expect(assertAutoCommitLeaseHeld(
      ctxRoot,
      'token-a',
      expiresAt - AUTO_COMMIT_PRE_COMMIT_MARGIN_MS - 1,
    ).status).toBe('held');

    const below = assertAutoCommitLeaseHeld(
      ctxRoot,
      'token-a',
      expiresAt - AUTO_COMMIT_PRE_COMMIT_MARGIN_MS + 1,
    );
    expect(below.status).toBe('error');
    expect(below.error).toContain('59999ms remaining; at least 60000ms is required');
    expect(assertAutoCommitLeaseHeld(ctxRoot, 'wrong-token', 2_000).status).toBe('error');
    expect(assertAutoCommitLeaseHeld(ctxRoot, 'token-a', expiresAt).status).toBe('error');
    expect(getAutoCommitLeaseStatus(ctxRoot, expiresAt - 1).status).toBe('active');
  });

  it('releases only with the exact token and allows the next writer', () => {
    acquireAutoCommitLease({ ctxRoot, holder: holderA, now: 1_000, ttlMs: 600_000, token: 'token-a' });

    expect(releaseAutoCommitLease({ ctxRoot, token: 'token-a', now: 2_000 })).toEqual({
      status: 'released',
      holder: holderA,
      released_at: 2_000,
    });
    expect(getAutoCommitLeaseStatus(ctxRoot, 2_000)).toEqual({ status: 'none' });
    expect(acquireAutoCommitLease({
      ctxRoot,
      holder: holderB,
      now: 3_000,
      ttlMs: 600_000,
      token: 'token-b',
    }).status).toBe('acquired');
  });

  it('reports an expired lease without mutating state during status', () => {
    acquireAutoCommitLease({ ctxRoot, holder: holderA, now: 1_000, ttlMs: MIN_AUTO_COMMIT_LEASE_TTL_MS, token: 'token-a' });
    const before = readFileSync(autoCommitLeasePath(ctxRoot), 'utf-8');

    expect(getAutoCommitLeaseStatus(ctxRoot, 301_000)).toEqual({
      status: 'expired',
      holder: holderA,
      acquired_at: 1_000,
      expires_at: 301_000,
    });
    expect(readFileSync(autoCommitLeasePath(ctxRoot), 'utf-8')).toBe(before);
  });

  it('fails closed on an unreadable lease record', () => {
    acquireAutoCommitLease({ ctxRoot, holder: holderA, now: 1_000, ttlMs: MIN_AUTO_COMMIT_LEASE_TTL_MS, token: 'token-a' });
    writeFileSync(autoCommitLeasePath(ctxRoot), '{not json', 'utf-8');

    expect(acquireAutoCommitLease({
      ctxRoot,
      holder: holderB,
      now: 2_000,
      ttlMs: MIN_AUTO_COMMIT_LEASE_TTL_MS,
      token: 'token-b',
    })).toEqual({
      status: 'error',
      error: 'auto-commit lease state is unreadable; refusing operation',
    });
  });

  it('accepts only bounded primitive and configured lease TTLs without clamping', () => {
    expect(acquireAutoCommitLease({
      ctxRoot,
      holder: holderA,
      now: 1_000,
      ttlMs: MIN_AUTO_COMMIT_LEASE_TTL_MS - 1,
      token: 'below-min',
    })).toEqual({
      status: 'error',
      error: `auto-commit lease TTL must be an integer between ${MIN_AUTO_COMMIT_LEASE_TTL_MS} and ${MAX_AUTO_COMMIT_LEASE_TTL_MS} milliseconds`,
    });
    expect(acquireAutoCommitLease({
      ctxRoot,
      holder: holderA,
      now: 1_000,
      ttlMs: MAX_AUTO_COMMIT_LEASE_TTL_MS + 1,
      token: 'above-max',
    }).status).toBe('error');
    expect(acquireAutoCommitLease({
      ctxRoot,
      holder: holderA,
      now: 1_000,
      ttlMs: MIN_AUTO_COMMIT_LEASE_TTL_MS,
      token: 'min-token',
    }).status).toBe('acquired');
    expect(releaseAutoCommitLease({ ctxRoot, token: 'min-token', now: 2_000 }).status).toBe('released');
    expect(acquireAutoCommitLease({
      ctxRoot,
      holder: holderA,
      now: 3_000,
      ttlMs: MAX_AUTO_COMMIT_LEASE_TTL_MS,
      token: 'max-token',
    }).status).toBe('acquired');

    const agentDir = join(ctxRoot, 'agent');
    const configPath = join(agentDir, 'config.json');
    mkdirSync(agentDir, { recursive: true });
    writeFileSync(configPath, JSON.stringify({
      ecosystem: { local_version_control: { lease_ttl_ms: MIN_AUTO_COMMIT_LEASE_TTL_MS } },
    }));
    expect(resolveAutoCommitLeaseTtlMs(agentDir)).toBe(MIN_AUTO_COMMIT_LEASE_TTL_MS);

    writeFileSync(configPath, JSON.stringify({
      ecosystem: { local_version_control: { lease_ttl_ms: MAX_AUTO_COMMIT_LEASE_TTL_MS } },
    }));
    expect(resolveAutoCommitLeaseTtlMs(agentDir)).toBe(MAX_AUTO_COMMIT_LEASE_TTL_MS);

    for (const value of [1, MIN_AUTO_COMMIT_LEASE_TTL_MS - 1, MAX_AUTO_COMMIT_LEASE_TTL_MS + 1]) {
      writeFileSync(configPath, JSON.stringify({
        ecosystem: { local_version_control: { lease_ttl_ms: value } },
      }));
      expect(() => resolveAutoCommitLeaseTtlMs(agentDir)).toThrow(
        `between ${MIN_AUTO_COMMIT_LEASE_TTL_MS} and ${MAX_AUTO_COMMIT_LEASE_TTL_MS}`,
      );
    }
  });
});
