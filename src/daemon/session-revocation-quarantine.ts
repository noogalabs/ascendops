import { revokeAgentSessionNonces } from '../bus/heartbeat-session-store.js';

/**
 * Boot revocation clears every persisted heartbeat session record, because a
 * record that outlives its daemon is a credential for a session nothing is
 * running. When ONE agent's records cannot be read — an unreadable directory,
 * a permission the operator has to repair — the sweep must not abort: that
 * would take the whole fleet down over one entry.
 *
 * But skipping is not safe either, and this is the part that is easy to get
 * wrong. Records are per-nonce, so an unrevoked stale record stays VALID
 * alongside the fresh generation the agent is about to mint. Starting that agent
 * anyway means two live generations, and a detached descendant of the dead
 * session can still refresh the agent's heartbeat — which is the exact defect
 * this whole change exists to close.
 *
 * So a failed revocation quarantines EXACTLY the affected agent from start and
 * admission, and every other agent boots normally. Scoped fail-closed: not
 * fleet-wide, and never silent. The quarantine lifts when a later revoke for
 * that agent succeeds, which is retried at each start attempt, so repairing the
 * permission is all an operator has to do.
 */
const quarantined = new Map<string, string>();

export function quarantineAgentForUnrevokedSession(agent: string, reason: string): void {
  quarantined.set(agent, reason);
}

/** The stated reason this agent may not start, or null when it may. */
export function sessionQuarantineReason(agent: string): string | null {
  return quarantined.get(agent) ?? null;
}

/**
 * Retry the revocation for a quarantined agent. Returns true when the agent may
 * start — either it was never quarantined, or the retry cleared its records.
 */
export function retrySessionRevocation(ctxRoot: string, agent: string): boolean {
  if (!quarantined.has(agent)) return true;
  try {
    revokeAgentSessionNonces(ctxRoot, agent);
  } catch {
    return false;
  }
  quarantined.delete(agent);
  return true;
}

/** Test seam. Production never clears a quarantine except by a successful revoke. */
export function resetSessionQuarantines(): void {
  quarantined.clear();
}
