/**
 * Publishes a heartbeat session record from a SEPARATE OS PROCESS, through the real
 * store — used by tests/unit/bus/session-nonce-race.test.ts so the interleave in
 * the casualty is an actual concurrent publish and not a same-process
 * simulation of one.
 *
 * usage: tsx tests/helpers/publish-session-nonce.ts <ctxRoot> <agent> <nonce>
 */
import { recordSessionNonce } from '../../src/bus/heartbeat-session-store.js';

const [ctxRoot, agent, nonce] = process.argv.slice(2);
if (!ctxRoot || !agent || !nonce) {
  console.error('usage: publish-session-nonce.ts <ctxRoot> <agent> <nonce>');
  process.exit(2);
}
recordSessionNonce(ctxRoot, agent, nonce);
