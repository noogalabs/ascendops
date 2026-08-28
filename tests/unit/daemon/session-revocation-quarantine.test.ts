import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, chmodSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { recordSessionNonce, revokeAllSessionNonces, isSessionNonceLive } from '../../../src/bus/heartbeat-session-store';
import {
  quarantineAgentForUnrevokedSession, sessionQuarantineReason,
  retrySessionRevocation, resetSessionQuarantines,
} from '../../../src/daemon/session-revocation-quarantine';

/**
 * Boot could not revoke one agent's stale session records. Skipping and carrying
 * on is NOT safe: records are per-nonce, so the record we could not remove stays
 * VALID alongside the fresh generation that agent is about to mint. Two live
 * generations means a detached descendant of the dead session can still refresh
 * the agent's heartbeat — the exact defect this change exists to close.
 *
 * So the failure quarantines EXACTLY that agent and every other agent boots.
 * Scoped fail-closed: not fleet-wide, and never silent.
 */
describe('an unknown revocation quarantines one agent, not the fleet', () => {
  let root: string;
  let locked: string;

  beforeEach(() => {
    resetSessionQuarantines();
    root = mkdtempSync(join(tmpdir(), 'cortextos-quarantine-'));
    recordSessionNonce(root, 'alpha', 'alpha-live-session-0001');
    recordSessionNonce(root, 'beta', 'beta-live-session-00001');
    recordSessionNonce(root, 'gamma', 'gamma-live-session-0001');
    locked = join(root, 'state', 'beta', 'heartbeat-sessions');
    chmodSync(locked, 0o000);
  });
  afterEach(() => {
    try { chmodSync(locked, 0o700); } catch { /* already restored */ }
    resetSessionQuarantines();
    rmSync(root, { recursive: true, force: true });
  });

  /** What the daemon's boot handler does with a per-agent failure. */
  function bootRevoke(): number {
    return revokeAllSessionNonces(root, (agent, error) =>
      quarantineAgentForUnrevokedSession(agent, `records could not be revoked at boot (${error})`));
  }

  it('quarantines exactly the affected agent and states the reason', () => {
    const revoked = bootRevoke();

    expect(revoked).toBe(2);
    expect(`beta=${sessionQuarantineReason('beta') === null ? 'may-start' : 'REFUSED'}`).toBe('beta=REFUSED');
    expect(sessionQuarantineReason('beta')).toMatch(/could not be revoked at boot/);
    // Every other agent boots. A fleet-wide stop would be a worse outcome than
    // the defect, which is why the sweep does not abort.
    expect(`alpha=${sessionQuarantineReason('alpha')} gamma=${sessionQuarantineReason('gamma')}`)
      .toBe('alpha=null gamma=null');
    expect(isSessionNonceLive(root, 'alpha', 'alpha-live-session-0001')).toBe(false);
  });

  it('a start attempt retries the revoke, and the refusal STANDS while it still fails', () => {
    bootRevoke();
    expect(`beta-may-start=${retrySessionRevocation(root, 'beta')}`).toBe('beta-may-start=false');
    expect(sessionQuarantineReason('beta')).not.toBeNull();
    // ...and the stale credential really is still live, which is WHY it is refused.
    chmodSync(locked, 0o700);
    expect(isSessionNonceLive(root, 'beta', 'beta-live-session-00001')).toBe(true);
  });

  it('repairing the permission lifts the quarantine on the next start attempt', () => {
    bootRevoke();
    chmodSync(locked, 0o700);

    expect(`beta-may-start=${retrySessionRevocation(root, 'beta')}`).toBe('beta-may-start=true');
    expect(sessionQuarantineReason('beta')).toBeNull();
    // The repair is a real revocation, not just a cleared flag.
    expect(isSessionNonceLive(root, 'beta', 'beta-live-session-00001')).toBe(false);
  });

  it('an agent that was never quarantined is never asked to retry', () => {
    bootRevoke();
    expect(retrySessionRevocation(root, 'alpha')).toBe(true);
    expect(existsSync(join(root, 'state', 'alpha', 'heartbeat-sessions'))).toBe(true);
  });

  it('AgentManager.startAgent REFUSES the quarantined agent and does not gate the others', async () => {
    // The policy above is only a policy until something halts on it. This asserts
    // the gate HALTS at the real admission point, and that it is scoped: alpha's
    // start gets PAST this gate (it may fail later for its own reasons, which is
    // a different failure and named as such).
    bootRevoke();
    const { AgentManager } = await import('../../../src/daemon/agent-manager');
    const am = new AgentManager('test-instance', root, root, 'acme');

    await expect(am.startAgent('beta', join(root, 'beta')))
      .rejects.toThrow(/beta cannot start:.*could not be revoked at boot/s);

    const alpha = await am.startAgent('alpha', join(root, 'alpha')).then(() => null, (e: Error) => e);
    expect(`alpha-blocked-by-this-gate=${/cannot start:.*could not be revoked/s.test(alpha?.message ?? '')}`)
      .toBe('alpha-blocked-by-this-gate=false');
  });
});
