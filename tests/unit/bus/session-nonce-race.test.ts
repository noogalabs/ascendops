import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, readdirSync, writeFileSync, existsSync } from 'fs';
import { execFileSync } from 'child_process';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  recordSessionNonce, clearSessionNonce, isSessionNonceLive,
} from '../../../src/bus/heartbeat-session-store';

/**
 * nova's TERMINAL RED on ac567b37: clearSessionNonceIfMatches READ the singleton
 * record, COMPARED it to the caller's nonce, then deleted the file. Between the read
 * and the delete, a replacement lifecycle could publish its own record — and the
 * dying lifecycle deleted it. The replacement then held a credential the store said
 * was not live, so its heartbeat refreshes were silently dropped.
 *
 * The successor makes the delete atomic on IDENTITY rather than check-then-act:
 * one file per nonce, and unlink on an exact path. There is no window because there
 * is no comparison — a lifecycle can only ever name its own path.
 *
 * The casualty nova specified, enacted literally: A pauses where the comparison
 * used to sit, B publishes FROM A SECOND OS PROCESS (so the interleave is real and
 * not a same-process simulation of one), A resumes and deletes. B must survive; A's
 * own record must be gone. Reverting the store to compare-and-delete turns this red.
 */

const AGENT = 'a1';
const A_NONCE = 'dying-lifecycle-nonce-01';
const B_NONCE = 'replacement-lifecycle-1';

describe('a dying lifecycle cannot delete a replacement record (nova TERMINAL RED)', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'cortextos-nonce-race-'));
    mkdirSync(join(root, 'state', AGENT), { recursive: true });
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  /** Publishes a record from a genuinely separate process, through the real store. */
  function publishFromASecondProcess(nonce: string): void {
    execFileSync(
      join(__dirname, '../../../node_modules/.bin/tsx'),
      [join(__dirname, '../../helpers/publish-session-nonce.ts'), root, AGENT, nonce],
      { stdio: 'pipe' },
    );
  }

  it('B publishes inside A\'s delete window from a second process, and B survives', () => {
    // A is live.
    recordSessionNonce(root, AGENT, A_NONCE);
    expect(isSessionNonceLive(root, AGENT, A_NONCE)).toBe(true);

    // --- A enters its clear. This is the point at which the old implementation had
    // already READ the singleton and decided the record was its own. Everything
    // after this line and before A's delete is the window nova found.
    publishFromASecondProcess(B_NONCE);

    // THE STRUCTURAL PROPERTY THAT CLOSES THE WINDOW. Two generations' records
    // COEXIST. Under the singleton shape they cannot: B's publish overwrote the one
    // path, so A's exit found B sitting where A's record had been and deleted it.
    // Records addressed by identity cannot collide, so there is nothing for A's
    // delete to mistake for its own. This assertion is what dies if the store is
    // reverted to one file per agent — the coexistence IS the fix.
    expect(`both-generations-live=${isSessionNonceLive(root, AGENT, A_NONCE)}/${isSessionNonceLive(root, AGENT, B_NONCE)}`)
      .toBe('both-generations-live=true/true');

    // A resumes and completes the delete it decided on.
    clearSessionNonce(root, AGENT, A_NONCE);
    // --- window closed.

    // B survives, so B's credential still passes the liveness predicate that
    // src/bus/event.ts consults before refreshing a heartbeat. Under the old
    // compare-and-delete this is false and B's refreshes are silently dropped.
    expect(`B-live-after-A-clear=${isSessionNonceLive(root, AGENT, B_NONCE)}`)
      .toBe('B-live-after-A-clear=true');

    // The mirror nova asked for: A's own record IS gone. A test that only checked
    // B's survival would pass on a clear that does nothing at all.
    expect(`A-live-after-A-clear=${isSessionNonceLive(root, AGENT, A_NONCE)}`)
      .toBe('A-live-after-A-clear=false');

    // And exactly one record remains, so the clear removed one file rather than
    // emptying or recreating the directory.
    expect(readdirSync(join(root, 'state', AGENT, 'heartbeat-sessions')).sort())
      .toEqual([`${B_NONCE}.json`]);
  });

  it('the same holds when B publishes BEFORE A begins clearing', () => {
    recordSessionNonce(root, AGENT, A_NONCE);
    publishFromASecondProcess(B_NONCE);
    clearSessionNonce(root, AGENT, A_NONCE);
    expect(isSessionNonceLive(root, AGENT, B_NONCE)).toBe(true);
    expect(isSessionNonceLive(root, AGENT, A_NONCE)).toBe(false);
  });

  it('a clear naming a nonce that was never recorded removes nothing', () => {
    // The dying lifecycle of a DIFFERENT agent generation, replayed late. It names
    // a path that does not exist; unlink on an absent path must not disturb B.
    publishFromASecondProcess(B_NONCE);
    clearSessionNonce(root, AGENT, 'a-nonce-never-recorded1');
    expect(isSessionNonceLive(root, AGENT, B_NONCE)).toBe(true);
  });

  it('a traversing nonce cannot delete a file outside the sessions directory', () => {
    // A weaker version of this test asserted only that A survived a traversing
    // clear. It passed with the shape guard REMOVED, because the traversal named a
    // path that happened not to exist — the test could not see the guard it was
    // named for. So plant a DECOY at exactly the path the traversal resolves to,
    // and require the decoy to survive. Now removing the guard kills this test.
    const decoyDir = join(root, 'state');
    const traversal = `../../${AGENT}-stolen`;
    const decoy = join(root, 'state', `${AGENT}-stolen.json`);
    mkdirSync(decoyDir, { recursive: true });
    writeFileSync(decoy, 'a file the store has no business deleting');

    recordSessionNonce(root, AGENT, A_NONCE);
    clearSessionNonce(root, AGENT, traversal);

    expect(`decoy-survived=${existsSync(decoy)}`).toBe('decoy-survived=true');
    expect(isSessionNonceLive(root, AGENT, A_NONCE)).toBe(true);
  });

  it('a malformed nonce is REFUSED at record time rather than silently unrecorded', () => {
    // If record quietly no-oped, a lifecycle would run believing it held a live
    // credential while every refresh it made was dropped — a silent half-ship.
    expect(() => recordSessionNonce(root, AGENT, 'short')).toThrow(/malformed/);
    expect(() => recordSessionNonce(root, AGENT, '../../../etc/passwd')).toThrow(/malformed/);
  });
});
