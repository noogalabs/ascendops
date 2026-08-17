import { Command } from 'commander';
import { IPCClient } from '../daemon/ipc-server.js';
import { writeStopMarker } from './stop.js';

export const restartCommand = new Command('restart')
  .argument('<agent>', 'Agent name to restart')
  .option('--instance <id>', 'Instance ID', 'default')
  .description('Restart a running agent through the daemon\'s guarded restart path (serialized stop + start). Re-reads config.json and .env, respawns the PTY. Does NOT restart the daemon process itself — use `pm2 restart cortextos-daemon` for that.')
  .action(async (agent: string, options: { instance: string }) => {
    const ipc = new IPCClient(options.instance);
    const daemonRunning = await ipc.isDaemonRunning();

    if (!daemonRunning) {
      console.error('Daemon is not running. Start it first: cortextos start');
      process.exit(1);
    }

    console.log(`Restarting agent: ${agent}`);

    // Write the .user-stop marker before the PTY is killed so the SessionEnd
    // crash-alert hook does not fire a false 🚨 CRASH alarm during the stop
    // window. (BUG-036 pattern.) It MUST outlive this command — see the
    // do-not-clear note on the restart-agent call below.
    writeStopMarker(options.instance, agent, 'stopped via cortextos restart');

    // SINGLE guarded IPC, not a hand-rolled stop-agent + start-agent pair.
    //
    // This command previously sent two separate IPC calls. That bypassed
    // AgentManager.restartAgent entirely — and restartAgent is where the
    // restart-serialization guard lives: `inFlightRestarts` around a strictly
    // sequenced `await stopAgent()` then `await startAgent()`, with
    // AgentProcess.stop() deduping on a stopPromise.
    //
    // Called SERIALIZATION, not single-writer, deliberately. "single-writer" is
    // already taken in this codebase by the auto-commit lease (types/index.ts:150),
    // which genuinely delivers it — an unexpired lease is `contended` even for the
    // same {org, agent}. Reusing the term for a guard that only sequences would
    // borrow a guarantee from a mechanism that has it.
    //
    // That SEQUENCES the two halves; it does NOT prove the old session is gone.
    // stop() races the exit promise against sleep(15000) and returns either way
    // (agent-process.ts:399-406), and a late exit is explicitly supported "no
    // matter how delayed it is" (:894-901). So startAgent() can run while the
    // former PTY is still alive. The sequencing NARROWS the overlap window; it
    // does not close it, and nothing here bounds the tail.
    //
    // That residual has an owner, not a shrug. The closure is to lease the TURN
    // rather than the commit, keyed {org, agent}, with renewal on a heartbeat as
    // the liveness proof — so a second continuation of the same agent is refused
    // while the first still holds. Tracked as task_1785555336924_76305344.
    //
    // Deliberately described rather than linked: the design doc lives on the
    // orchestrator tree, NOT in this repo's main branch, so a path citation here
    // would not resolve for anyone who checks this branch out.
    //
    // Until that lands, treat the guarded path as narrowing the window, never as
    // excluding a second writer.
    //
    // Two independent calls have a window between them. On 2026-08-14 that
    // window produced SAME-AGENT CONCURRENT TURNS on a codex agent: one
    // continuation committed and pushed while another ran a full suite toward
    // the same work. Nothing was lost only because the second continuation
    // verified head/tree/remote equality and declined to duplicate — verify-first
    // discipline compensating for a missing invariant, which holds right up
    // until the two writers are not byte-identical.
    //
    // Routing through restart-agent puts the operator path back under the same
    // guard the daemon already applies to itself — the same sequencing, and the
    // same residual described above.
    const resp = await ipc.send({ type: 'restart-agent', agent, source: 'cortextos restart' });
    // DEDUPED is not a failure and must not be reported as one (Codex, 6efa5fbc).
    // agent-manager.ts:639-640 returns it when `inFlightRestarts.has(name)` — a
    // guarded restart is ALREADY RUNNING and this duplicate was declined. Nothing
    // is broken and nothing needs recovering.
    //
    // The previous branch printed "Restart failed" and recommended
    // `cortextos start <agent>`. That advice is actively harmful here: it points
    // the operator at a separate start-agent request while the guarded restart is
    // still stopping — the same hand-rolled bypass this command exists to replace.
    // An error message that recommends the bypass undoes the change it ships with.
    if (!resp.success && resp.code === 'DEDUPED') {
      console.log(`  ${resp.error}`);
      console.log(`  The in-flight restart continues; no action needed.`);
      return;
    }
    if (!resp.success) {
      console.error(`  Restart failed: ${resp.error}`);
      console.error(`  Agent may be stopped. Check with: cortextos status`);
      console.error(`  Recover with: cortextos start ${agent}`);
      process.exit(1);
    }
    console.log(`  ${resp.data}`);

    // DO NOT clear .user-stop here. (Codex review P1 on 2a1f9b33, confirmed
    // against the branch.) The restart-agent IPC handler dispatches
    // restartAgent() WITHOUT awaiting and returns success immediately, while
    // performStop() runs a runtime-dependent graceful branch (6s at worst, on the
    // default Claude path: 1s + 5s) then races a 15s exit timeout — so a
    // clear on IPC acceptance lands seconds BEFORE the dying session's
    // SessionEnd hook runs.
    //
    // The marker must survive that. A single restart fires SessionEnd TWICE
    // (~13-22s apart: once from the dying PTY, once from the next PTY's
    // fresh-launch cleanup), and hook-crash-alert classifies WITHOUT consuming
    // the marker precisely so both firings classify correctly. Unlinking early
    // is what produced the `type=crash reason=none` false-positive pairs in
    // crashes.log that that design exists to kill.
    //
    // Cleanup already has owners, and neither is here. clearEndMarkers() is
    // PRIMARY, running on a post-restart heartbeat once the marker is AT OR OLDER
    // THAN the 120s grace floor — NOT necessarily the successor's first heartbeat,
    // which may fall inside grace and skip the marker. classifyFromMarkers()'s
    // MARKER_TTL_MS lazy-unlink is the failed-start backstop.
  });
