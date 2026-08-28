import { HEARTBEAT_SESSION_ENV } from '../utils/env.js';

/**
 * The first statement of every hook entry point.
 *
 * PROCESS LINEAGE IS NOT INTENT. A hook runs inside the agent's session and
 * therefore inherits its credential, which proves only that this process
 * DESCENDS from that session — never that the agent is doing work. A SessionEnd
 * hook descends from the session precisely because the session is ending, which
 * is the strongest possible lineage and the weakest possible liveness claim.
 * Left unstripped, a crash notification refreshes the heartbeat of the agent
 * that just crashed.
 *
 * Hooks are reactions to lifecycle events, never the agent's own work, so NO
 * hook legitimately needs the credential. If a future hook argues otherwise that
 * is a ruling, not a code change.
 *
 * Stripping here rather than at each spawn site is deliberate: the chain that
 * exposed this had three hops and ZERO explicit `process.env` mentions — every
 * one inherited by OMITTING the env option, which no text census can see. A
 * boundary closes what an enumeration cannot.
 */
export function hookBootstrap(): void {
  delete process.env[HEARTBEAT_SESSION_ENV];
}
