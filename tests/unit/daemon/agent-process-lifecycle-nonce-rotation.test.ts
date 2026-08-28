import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { isSessionNonceLive } from '../../../src/bus/heartbeat-session-store';

/**
 * nova's TERMINAL RED on 8457d379. The cached nonce was set once and never
 * rotated: start A captured A, stop cleared A's FILE but left the FIELD set,
 * start B published B, and the capture then REFUSED to replace the cached A — so
 * B's record was owned by nothing and survived every later exit. A durable stale
 * credential after every second lifecycle.
 *
 * This is the worker lost-update bug rediscovered in the agent path, and it takes
 * the same fix: nonce ownership is per LIFECYCLE and the identity travels with
 * the clear, so a generation may only revoke the record it owns.
 *
 * Its own file, deliberately: crash-recovery timers armed by tests in the leak
 * suite fire later and construct another PTY, which consumed a nonce out of this
 * suite's queue and made the failure look like a rotation bug. Isolation here is
 * load-bearing, not tidiness.
 */

const A = 'lifecycle-A-nonce-00001';
const B = 'lifecycle-B-nonce-00001';

const mocks = vi.hoisted(() => ({ ctxRoot: '', queue: [] as string[], exits: [] as Array<(c: number) => void>, stray: 0 }));

vi.mock('../../../src/pty/agent-pty.js', () => ({
  AgentPTY: function AgentPTY() {
    let exitCallback: ((code: number) => void) | undefined;
    // Each PTY instance takes the next nonce: two lifecycles mint two records,
    // which is the whole point. Anything beyond the scripted two is a stray and
    // gets a nonce that cannot be mistaken for A or B.
    const mine = mocks.queue.length ? mocks.queue.shift()! : `stray-lifecycle-nonce-${++mocks.stray}`;
    return {
      spawn: async () => {
        const store = await import('../../../src/bus/heartbeat-session-store');
        store.recordSessionNonce(mocks.ctxRoot, 'alice', mine);
      },
      sessionNonce: () => mine,
      kill: () => { exitCallback?.(0); },
      write: vi.fn(),
      getPid: () => process.pid,
      isAlive: () => true,
      getOutputBuffer: () => ({ hasRateLimitSignature: () => false }),
      onExit: (cb: (code: number) => void) => { exitCallback = cb; mocks.exits.push(cb); },
    };
  },
}));

describe('nonce ownership is per LIFECYCLE, not per AgentProcess', () => {
  let root: string;

  function newProc(AgentProcess: new (...a: never[]) => { start(): Promise<void>; stop(): Promise<void> }) {
    return new AgentProcess('alice', {
      instanceId: 'test', ctxRoot: root, frameworkRoot: root,
      agentName: 'alice', agentDir: root, org: 'acme', projectRoot: root,
    } as never, {} as never, () => {});
  }

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'cortextos-two-lifecycles-'));
    mkdirSync(join(root, 'state', 'alice'), { recursive: true });
    mocks.ctxRoot = root;
    mocks.queue = [A, B];
    mocks.exits = [];
    mocks.stray = 0;
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('two successive lifecycles: B replaces A, and stopping B clears B', async () => {
    const { AgentProcess } = await import('../../../src/daemon/agent-process');
    const proc = newProc(AgentProcess as never);
    const trace: string[] = [];
    const snap = (label: string) => trace.push(
      `${label}:A=${isSessionNonceLive(root, 'alice', A)},B=${isSessionNonceLive(root, 'alice', B)}`);

    await proc.start(); snap('after-start-A');
    await proc.stop(); snap('after-stop-A');
    await proc.start(); snap('after-start-B');
    await proc.stop(); snap('after-stop-B');

    // The whole sequence in one assertion: a test that only checked the end state
    // would pass on a clear that removed everything, and one that only checked B
    // would pass on a stop that removed nothing.
    expect(trace.join(' | ')).toBe(
      'after-start-A:A=true,B=false | after-stop-A:A=false,B=false | '
      + 'after-start-B:A=false,B=true | after-stop-B:A=false,B=false');
  }, 40000);   // stop() runs the real Claude-REPL exit dance; no fake timers here

  it("a LATE exit from lifecycle A, arriving after B started, deletes nothing of B's", async () => {
    // The mirror. The reset that lets B replace A must not let A's late exit name
    // B — that would be the worker lost update reappearing on the way out.
    const { AgentProcess } = await import('../../../src/daemon/agent-process');
    const proc = newProc(AgentProcess as never);

    await proc.start();
    const lateExitFromA = mocks.exits[0];
    await proc.stop();
    await proc.start();
    expect(isSessionNonceLive(root, 'alice', B)).toBe(true);

    lateExitFromA(1);                      // A's exit arrives late, after B started

    expect(`B-survived-A-late-exit=${isSessionNonceLive(root, 'alice', B)}`)
      .toBe('B-survived-A-late-exit=true');
  }, 40000);
});

describe('the clear compares generation, so a stale caller deletes nothing', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'cortextos-stale-gen-'));
    mkdirSync(join(root, 'state', 'alice'), { recursive: true });
    mocks.ctxRoot = root;
    mocks.queue = [A, B];
    mocks.exits = [];
    mocks.stray = 0;
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('handleExit called with a PREVIOUS generation leaves the current record alone', async () => {
    // The onExit wiring already discards a late exit from a dead lifecycle
    // (BUG-040's generation guard), so the compare inside the clear is not
    // observable through that path — the mutation that removes it survives every
    // test that goes through onExit. This reaches the clear DIRECTLY, which is
    // the only way to see whether the compare is load-bearing or decoration.
    const { AgentProcess } = await import('../../../src/daemon/agent-process');
    const proc = new AgentProcess('alice', {
      instanceId: 'test', ctxRoot: root, frameworkRoot: root,
      agentName: 'alice', agentDir: root, org: 'acme', projectRoot: root,
    } as never, {} as never, () => {});

    await proc.start();                                   // lifecycle 1 owns A
    await proc.stop();
    await proc.start();                                   // lifecycle 2 owns B
    expect(isSessionNonceLive(root, 'alice', B)).toBe(true);

    // Lifecycle 1's exit, arriving after lifecycle 2 published.
    (proc as unknown as { handleExit(code: number, generation: number): void }).handleExit(1, 1);

    expect(`B-survived-stale-generation-clear=${isSessionNonceLive(root, 'alice', B)}`)
      .toBe('B-survived-stale-generation-clear=true');
  }, 40000);
});
