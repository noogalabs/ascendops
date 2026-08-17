/**
 * Unit-test parity for the `cortextos restart <agent>` subcommand
 * (issue #328). Companion to lifecycle-markers.test.ts which already
 * covers writeStopMarker — restart re-uses that helper, so this file
 * pins the command-level wiring (name, required argument, --instance
 * option, description) instead of duplicating the marker-write tests.
 */
import { beforeEach, describe, it, expect, vi } from 'vitest';

const sentRequests: Array<Record<string, unknown>> = [];
// Overridable so the DEDUPED branch can be exercised. Default stays success:true
// for every pre-existing case, which must keep passing unchanged.
const ipcState = vi.hoisted(() => ({ nextResponse: null as Record<string, unknown> | null }));
vi.mock('../../../src/daemon/ipc-server.js', () => ({
  IPCClient: class {
    async isDaemonRunning() { return true; }
    async send(request: Record<string, unknown>) {
      sentRequests.push(request);
      if (ipcState.nextResponse) return ipcState.nextResponse;
      return { success: true, data: `ok:${request.type}` };
    }
  },
}));
// vi.mock is hoisted above module scope, so the mock object must be created
// inside vi.hoisted() or it is not initialised when the factory runs.
const stopMocks = vi.hoisted(() => ({ writeStopMarker: vi.fn() }));
vi.mock('../../../src/cli/stop.js', () => stopMocks);
import { restartCommand } from '../../../src/cli/restart';

describe('issue #328: cortextos restart <agent>', () => {
  it('is registered as `restart`', () => {
    expect(restartCommand.name()).toBe('restart');
  });

  it('requires the <agent> positional argument', () => {
    // commander stores arg metadata on _args / registeredArguments depending on
    // version; both expose .required on the registered argument.
    const args = (restartCommand as unknown as { registeredArguments: { required: boolean; name: () => string }[] }).registeredArguments;
    expect(args).toHaveLength(1);
    expect(args[0].required).toBe(true);
    expect(args[0].name()).toBe('agent');
  });

  it('accepts --instance with a default of "default"', () => {
    const opts = restartCommand.opts();
    expect(opts.instance).toBe('default');
  });

  it('describes itself as a stop+start (not a daemon restart)', () => {
    // The description must make clear this does NOT bounce the daemon —
    // operator-facing UX guard so users don't reach for this when they
    // actually need `pm2 restart cortextos-daemon`.
    const desc = restartCommand.description().toLowerCase();
    expect(desc).toContain('stop');
    expect(desc).toContain('start');
    expect(desc).toContain('daemon');
  });
});

describe('restart routes through the GUARDED daemon path (2026-08-14)', () => {
  beforeEach(() => { sentRequests.length = 0; stopMocks.writeStopMarker.mockClear(); ipcState.nextResponse = null; });

  it('sends ONE restart-agent IPC, not a hand-rolled stop+start pair', async () => {
    await restartCommand.parseAsync(['alice'], { from: 'user' });

    // What this pins: AgentManager.restartAgent holds the restart-serialization
    // (inFlightRestarts + strictly sequenced await stopAgent -> await startAgent,
    // with AgentProcess.stop() deduping on a stopPromise). A separate stop-agent
    // then start-agent pair bypasses that guard entirely. The guarded path narrows
    // the overlap window; it does not close it — see the residual noted in
    // src/cli/restart.ts. On 2026-08-14 the unguarded window produced same-agent
    // concurrent turns on a codex agent — one continuation committing while
    // another ran tests.
    expect(sentRequests).toContainEqual(expect.objectContaining({ type: 'restart-agent', agent: 'alice' }));

    // Negative control: the bypassing pair must NOT be present. Without this the
    // test passes on an implementation that sends restart-agent AND the old pair.
    expect(sentRequests.filter(r => r.type === 'stop-agent')).toHaveLength(0);
    expect(sentRequests.filter(r => r.type === 'start-agent')).toHaveLength(0);
    expect(sentRequests.filter(r => r.type === 'restart-agent')).toHaveLength(1);
  });

  it('#859 stop-half intent survives the move: restartAgent stops non-user-initiated', async () => {
    // Previously pinned here as `userInitiated: false` on an explicit stop-agent.
    // That flag existed so BUG-031 could honour a restart queued while stopping.
    // restartAgent calls stopAgent(name) with userInitiated defaulting to false,
    // so the guarantee is preserved structurally rather than by a passed flag —
    // and there is no longer a caller-supplied flag that could be passed wrongly.
    await restartCommand.parseAsync(['alice'], { from: 'user' });
    const stops = sentRequests.filter(r => r.type === 'stop-agent');
    expect(stops).toHaveLength(0);
  });

  it('writes the .user-stop marker for the requested agent before the stop begins', async () => {
    // Codex review P1. restart-agent dispatches restartAgent() WITHOUT awaiting
    // and returns immediately, while performStop sleeps seconds before the PTY
    // dies. Clearing on IPC acceptance removes the marker BEFORE the dying
    // session's SessionEnd hook runs — and that hook fires TWICE per restart,
    // classifying without consuming the marker. An early unlink is what produced
    // the `type=crash reason=none` false-positive pairs. Cleanup has two owners,
    // neither of them here: clearEndMarkers() on a post-restart heartbeat that runs
    // once the marker is at or older than the grace floor (primary — NOT
    // necessarily the first heartbeat, which may fall inside grace and skip it),
    // and classifyFromMarkers()'s MARKER_TTL_MS lazy-unlink (failed-start
    // backstop).
    //
    // THAT SURVIVAL IS NOT PINNED HERE, and deliberately so. A previous version
    // asserted `'clearStopMarker' not in Object.keys(stopMocks)` — which reads
    // like a guard and is not one: it inspects an object literal built by this
    // test, so an eager unlink written inline, or under any other name, keeps it
    // green. It was removed rather than left as reassuring scenery.
    //
    // Marker lifetime is EXERCISED against a real file in
    // tests/unit/cli/restart-marker-lifetime.test.ts. What that file does and does
    // not establish is stated in its PROOF CONTRACT — comments in OTHER files do
    // not characterize it. "Proven" was too strong and was not this comment's to
    // award. This case covers only the write.
    await restartCommand.parseAsync(['alice'], { from: 'user' });
    expect(stopMocks.writeStopMarker).toHaveBeenCalledWith('default', 'alice', expect.any(String));
  });
});

describe('DEDUPED is reported as a non-failure, not as a restart that needs recovery', () => {
  // Codex P2 on 6efa5fbc. agent-manager.ts:639-640 returns
  // `{ ok:false, code:'DEDUPED' }` for op==='restart' when inFlightRestarts
  // already holds the agent, and ipc-server.ts:647-670 passes that straight
  // through as `{ success:false, code:'DEDUPED' }`. It means a guarded restart
  // is ALREADY RUNNING — the request was declined, nothing failed.
  //
  // The old branch printed "Restart failed" and told the operator to run
  // `cortextos start <agent>`. That is the exact hand-rolled bypass this PR
  // exists to replace, recommended by the PR's own error message, at the one
  // moment a restart is mid-flight and a stray start would race it.
  //
  // NOT PINNED HERE: the exit code. The DEDUPED path returns from the action
  // handler rather than calling process.exit, so there is no observable status
  // to assert under vitest without spawning the CLI. What IS pinned is the
  // absence of the bypass recommendation and of failure framing.
  beforeEach(() => { sentRequests.length = 0; stopMocks.writeStopMarker.mockClear(); ipcState.nextResponse = null; });

  const DEDUPED = {
    success: false,
    code: 'DEDUPED',
    error: 'restart request for "alice" deduped — restart already in flight',
  };

  function captureOutput() {
    const out: string[] = [];
    const err: string[] = [];
    const logSpy = vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => { out.push(a.join(' ')); });
    const errSpy = vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => { err.push(a.join(' ')); });
    return { out, err, restore: () => { logSpy.mockRestore(); errSpy.mockRestore(); } };
  }

  it('does NOT recommend `cortextos start` when the daemon reports DEDUPED', async () => {
    ipcState.nextResponse = DEDUPED;
    const cap = captureOutput();
    try {
      await restartCommand.parseAsync(['alice'], { from: 'user' });
    } finally { cap.restore(); }

    const all = [...cap.out, ...cap.err].join('\n');
    expect(all, 'DEDUPED must not recommend the start-agent bypass while a restart is in flight')
      .not.toContain('cortextos start');
    expect(all.toLowerCase(), 'DEDUPED is not a failed restart').not.toContain('restart failed');
  });

  it('tells the operator the in-flight restart is continuing', async () => {
    // Negative-space assertions alone would pass on a branch that prints
    // nothing at all, leaving the operator with silence after a declined
    // command. The positive half pins that something informative is said.
    ipcState.nextResponse = DEDUPED;
    const cap = captureOutput();
    try {
      await restartCommand.parseAsync(['alice'], { from: 'user' });
    } finally { cap.restore(); }

    const stdout = cap.out.join('\n');
    expect(stdout, 'the daemon\'s reason must reach the operator').toContain('deduped');
    expect(stdout.toLowerCase()).toContain('continue');
    expect(cap.err, 'DEDUPED must not be written to stderr as an error').toEqual([]);
  });

  it('STILL recommends recovery for a genuine failure — the fix must not swallow real errors', async () => {
    // The half most likely to be lost. Narrowing a failure branch is only
    // correct if the branch still fires for everything it legitimately covered.
    // process.exit is stubbed because the real one would tear down the runner.
    ipcState.nextResponse = { success: false, code: 'NOT_FOUND', error: 'agent "alice" not in registry — cannot restart' };
    const cap = captureOutput();
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((): never => {
      throw new Error('__exit__');
    }) as never);
    // mockRestore() CLEARS call history, so the exit codes are read out before
    // the spy is torn down. Restoring first made this case fail with 0 calls
    // while the stderr halves passed — a harness fault that reads exactly like
    // a code fault.
    let exitCodes: unknown[] = [];
    try {
      await restartCommand.parseAsync(['alice'], { from: 'user' });
    } catch (error) {
      expect((error as Error).message).toBe('__exit__');
    } finally {
      exitCodes = exitSpy.mock.calls.map((call) => call[0]);
      cap.restore();
      exitSpy.mockRestore();
    }

    const stderr = cap.err.join('\n');
    expect(stderr, 'a non-DEDUPED failure must still be framed as a failure').toContain('Restart failed');
    expect(stderr, 'a genuine failure must still offer recovery').toContain('cortextos start alice');
    expect(exitCodes, 'a genuine failure must still exit non-zero').toEqual([1]);
  });
});
