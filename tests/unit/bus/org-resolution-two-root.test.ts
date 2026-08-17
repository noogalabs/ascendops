import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, existsSync, readdirSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { sendMessage, orgFromPathsForTest } from '../../../src/bus/message';
import type { BusPaths } from '../../../src/types';

/**
 * Regression: `_orgFromPaths` walked for `<root>/analytics/<org>`, a shape
 * buildBusPaths has never produced. The real org-scoped shape is
 * `<ctxRoot>/orgs/<org>/analytics`, so 'analytics' is always the LAST segment
 * and the org sits BEFORE it. The old guard (`idx + 1 < parts.length`) was
 * therefore never true: the branch had never executed once in production, the
 * helper silently degraded to CTX_ORG, and events for one org landed under two
 * different roots wherever that env var was absent.
 *
 * These tests fail against the pre-fix implementation. The first one is the
 * important one — the old code could not reach its own return statement, which
 * is exactly the defect class that passes review and passes a test suite whose
 * fixtures only ever build the UNSCOPED path shape (as tests/unit/bus/message.test.ts
 * does). The fixture is asserted against the real builder below so it cannot
 * drift back into a shape that re-hides the bug.
 */

// Mirrors buildBusPaths (src/utils/paths.ts): org ? join(ctxRoot,'orgs',org) : ctxRoot
function pathsFor(ctxRoot: string, agent: string, org?: string): BusPaths {
  const orgBase = org ? join(ctxRoot, 'orgs', org) : ctxRoot;
  return {
    ctxRoot,
    inbox: join(ctxRoot, 'inbox', agent),
    inflight: join(ctxRoot, 'inflight', agent),
    processed: join(ctxRoot, 'processed', agent),
    logDir: join(ctxRoot, 'logs', agent),
    stateDir: join(ctxRoot, 'state', agent),
    taskDir: join(orgBase, 'tasks'),
    approvalDir: join(orgBase, 'approvals'),
    analyticsDir: join(orgBase, 'analytics'),
    deliverablesDir: join(orgBase, 'deliverables'),
  } as BusPaths;
}

function readArrivalEvent(paths: BusPaths, agent: string): Record<string, unknown> {
  const dir = join(paths.analyticsDir, 'events', agent);
  expect(existsSync(dir)).toBe(true);
  const files = readdirSync(dir).filter((f) => f.endsWith('.jsonl'));
  expect(files.length).toBeGreaterThan(0);
  const lines = readFileSync(join(dir, files[0]), 'utf-8').trim().split('\n');
  const arrival = lines
    .map((l) => JSON.parse(l))
    .find((e) => e.event === 'inbox_arrival');
  expect(arrival).toBeDefined();
  return arrival as Record<string, unknown>;
}

describe('org resolution from BusPaths (two-root regression)', () => {
  let ctxRoot: string;
  let savedOrg: string | undefined;

  beforeEach(() => {
    ctxRoot = mkdtempSync(join(tmpdir(), 'cortextos-org-resolution-'));
    savedOrg = process.env.CTX_ORG;
    // The defect was masked in production wherever CTX_ORG happened to be set.
    // Clear it so the test measures path resolution and nothing else.
    delete process.env.CTX_ORG;
  });

  afterEach(() => {
    if (savedOrg === undefined) delete process.env.CTX_ORG;
    else process.env.CTX_ORG = savedOrg;
    rmSync(ctxRoot, { recursive: true, force: true });
  });

  it('fixture matches the real builder shape (guards against re-hiding the bug)', () => {
    const scoped = pathsFor(ctxRoot, 'receiver', 'ascendops');
    expect(scoped.analyticsDir).toBe(join(ctxRoot, 'orgs', 'ascendops', 'analytics'));
    // The two facts the old implementation got wrong, asserted directly.
    const parts = scoped.analyticsDir.split('/');
    expect(parts[parts.length - 1]).toBe('analytics'); // always LAST
    expect(parts[parts.length - 2]).toBe('ascendops'); // org sits BEFORE it
  });

  it('tags the event with the org taken from an org-scoped analyticsDir', () => {
    const paths = pathsFor(ctxRoot, 'receiver', 'ascendops');
    sendMessage(paths, 'sender', 'receiver', 'normal', 'hello');
    // Pre-fix this was '' — the branch that should return the org never ran.
    expect(readArrivalEvent(paths, 'receiver').org).toBe('ascendops');
  });

  it('resolves a different org to a different tag (single root per org)', () => {
    const paths = pathsFor(ctxRoot, 'receiver', 'other-org');
    sendMessage(paths, 'sender', 'receiver', 'normal', 'hello');
    expect(readArrivalEvent(paths, 'receiver').org).toBe('other-org');
  });

  it('falls back to CTX_ORG for an unscoped analyticsDir rather than inventing an org', () => {
    process.env.CTX_ORG = 'env-org';
    const paths = pathsFor(ctxRoot, 'receiver'); // <ctxRoot>/analytics, no org segment
    sendMessage(paths, 'sender', 'receiver', 'normal', 'hello');
    expect(readArrivalEvent(paths, 'receiver').org).toBe('env-org');
  });

  // CASUALTY 1 (builder, review of 6e25b670). My first fix used a SUFFIX heuristic —
  // "is the segment two back literally 'orgs'" — with no anchor to ctxRoot. That is
  // defeated by a ctxRoot which itself ends in orgs/<something>: the UNSCOPED path
  // <ctxRoot>/analytics then looks org-scoped and the helper returns the last segment
  // of the ROOT as if it were an org.
  //
  // My original version of this test used mkdtemp with an 'orgs-' prefix, producing a
  // segment named 'orgs-a1b2c3' — which is NOT the literal 'orgs' segment the code
  // keys on. So it asserted a WEAKER predicate than its own name claimed and passed
  // against broken code. Same claim-to-instrument failure I have a rule about, inside
  // the test written to prevent it.
  it('does not treat a ctxRoot ENDING in orgs/<segment> as an org scope', () => {
    const base = mkdtempSync(join(tmpdir(), 'cortextos-disposable-'));
    try {
      const ctxRootUnderOrgs = join(base, 'orgs', 'root-child'); // literal 'orgs' segment
      process.env.CTX_ORG = 'env-org';
      const paths = pathsFor(ctxRootUnderOrgs, 'receiver'); // unscoped: <ctxRoot>/analytics
      sendMessage(paths, 'sender', 'receiver', 'normal', 'hello');
      // Pre-repair this returned 'root-child', the tail of the ROOT.
      expect(readArrivalEvent(paths, 'receiver').org).toBe('env-org');
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it('still resolves a real org scope nested under an orgs-ending ctxRoot', () => {
    // The anchor must not over-correct: a genuine org scope below such a root still resolves.
    const base = mkdtempSync(join(tmpdir(), 'cortextos-disposable-'));
    try {
      const ctxRootUnderOrgs = join(base, 'orgs', 'root-child');
      const paths = pathsFor(ctxRootUnderOrgs, 'receiver', 'real-org');
      sendMessage(paths, 'sender', 'receiver', 'normal', 'hello');
      expect(readArrivalEvent(paths, 'receiver').org).toBe('real-org');
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  // CASUALTY 2 (builder, same review). split('/') cannot parse what join() emits on
  // win32, so an org-scoped Windows path fell through to CTX_ORG. Parsing is now
  // separator-agnostic, which also means this is checkable on a posix host instead of
  // only on the platform where it is hardest to check.
  //
  // I had DISCLOSED this as pre-existing and out of scope in the dispatch. Disclosure
  // is not coverage — a named blind spot becomes a required test or it is just
  // liability transfer.
  it('parses win32-shaped paths (separator-agnostic, no host-platform dependency)', () => {
    const winPaths = {
      ctxRoot: 'C:\\ctx',
      analyticsDir: 'C:\\ctx\\orgs\\win-org\\analytics',
    } as BusPaths;
    expect(orgFromPathsForTest(winPaths)).toBe('win-org');

    const winUnscoped = {
      ctxRoot: 'C:\\ctx',
      analyticsDir: 'C:\\ctx\\analytics',
    } as BusPaths;
    process.env.CTX_ORG = 'env-org';
    expect(orgFromPathsForTest(winUnscoped)).toBe('env-org');
  });

  it('rejects shapes buildBusPaths never produces rather than guessing an org', () => {
    process.env.CTX_ORG = 'env-org';
    const bogus = [
      join(ctxRoot, 'orgs', 'analytics'),                      // missing org segment
      join(ctxRoot, 'orgs', 'a', 'b', 'analytics'),            // too deep
      join(ctxRoot, 'notorgs', 'some-org', 'analytics'),       // wrong marker
      join(ctxRoot, 'orgs', 'some-org', 'analytics', 'extra'), // analytics not terminal
    ];
    for (const analyticsDir of bogus) {
      expect(orgFromPathsForTest({ ctxRoot, analyticsDir } as BusPaths)).toBe('env-org');
    }
  });
});
