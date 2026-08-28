import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, chmodSync, existsSync, readdirSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { recordSessionNonce, revokeAllSessionNonces } from '../../../src/bus/heartbeat-session-store';
import { bindInstanceAndReconcileSessionRecords } from '../../../src/daemon/instance-boot-sequence';

/**
 * nova's TERMINAL RED on 98f36bac, and it is my OWN per-agent EACCES finding
 * applied one directory up. The per-agent sweep fails closed by quarantining the
 * agent it could not read. The ROOT read above it did not: it caught every error
 * and returned 0, and my comment said "no state directory yet, or it is
 * unreadable" — the conflation written down in plain sight.
 *
 * The consequence is worse than the per-agent case, not milder. When the root
 * cannot be enumerated, NO agent name is produced, so the per-agent quarantine
 * machinery never runs at all. Boot reads the failure as a successful
 * zero-record revocation, binds, and starts agents, while every stale per-nonce
 * credential beneath that root stays valid. The liveness spoof comes back
 * fleet-wide, through the very function written to close it.
 *
 * ABSENCE AND UNOBSERVABILITY ARE DIFFERENT. ENOENT means zero records. Anything
 * else means the population cannot be SCOPED, and an unscopable population cannot
 * be quarantined agent by agent.
 */
describe('the revocation census root distinguishes absence from unobservability', () => {
  let root: string;
  let stateRoot: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'cortextos-census-root-'));
    recordSessionNonce(root, 'alpha', 'alpha-stale-session-001');
    recordSessionNonce(root, 'beta', 'beta-stale-session-0001');
    stateRoot = join(root, 'state');
  });
  afterEach(() => {
    try { chmodSync(stateRoot, 0o700); } catch { /* already restored */ }
    rmSync(root, { recursive: true, force: true });
  });

  it('an UNREADABLE state root refuses boot instead of reporting zero records', () => {
    chmodSync(stateRoot, 0o000);

    expect(() => revokeAllSessionNonces(root, () => {}))
      .toThrow(/cannot be enumerated[\s\S]*affected population cannot be scoped/);

    // ...and the stale credentials are still there. They are explicitly UNKNOWN,
    // not silently revoked and not silently accepted.
    chmodSync(stateRoot, 0o700);
    expect(readdirSync(join(stateRoot, 'alpha', 'heartbeat-sessions')))
      .toEqual(['alpha-stale-session-001.json']);
  });

  it('an ABSENT state root is zero records and proceeds — the ENOENT mirror', () => {
    rmSync(stateRoot, { recursive: true, force: true });
    expect(existsSync(stateRoot)).toBe(false);
    expect(revokeAllSessionNonces(root, () => {})).toBe(0);
  });

  it('the boot sequence does not START agents when the census cannot be taken', async () => {
    // The gate has to HALT, not merely throw somewhere. This drives the real boot
    // sequence: an unreadable root must abort before anything downstream of
    // revocation runs.
    chmodSync(stateRoot, 0o000);
    let bound = false;
    let reachedPastRevocation = false;

    await expect(bindInstanceAndReconcileSessionRecords({
      probe: async () => false,
      bind: async () => { bound = true; },
      revoke: () => { revokeAllSessionNonces(root, () => {}); reachedPastRevocation = true; },
    })).rejects.toThrow(/cannot be enumerated/);

    expect(`bound=${bound} reached-past-revocation=${reachedPastRevocation}`)
      .toBe('bound=true reached-past-revocation=false');
  });

  it('a readable root still revokes every agent beneath it', () => {
    expect(revokeAllSessionNonces(root, () => {})).toBe(2);
  });
});
