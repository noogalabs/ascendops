import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

const repoRoot = join(__dirname, '../../..');
const scriptPath = join(repoRoot, 'scripts', 'forge-candidates.mjs');

function run(args: string[]) {
  try {
    const stdout = execFileSync(process.execPath, [scriptPath, ...args], {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { status: 0, stdout, stderr: '' };
  } catch (err: any) {
    return {
      status: err.status ?? 1,
      stdout: err.stdout?.toString() ?? '',
      stderr: err.stderr?.toString() ?? '',
    };
  }
}

let tmp: string;
let runsDir: string;
let eventsRoot: string;

// Real observed shapes from the live store (2026-06-07 rich shape and
// 2026-06-08 slim shape) — the queue reader must tolerate both.
const RICH_EVENT = {
  id: '1780842855-dane-4l11r',
  agent: 'dane',
  org: 'ascendops',
  timestamp: '2026-06-07T14:34:15Z',
  category: 'action',
  event: 'forge_candidate',
  severity: 'info',
  metadata: {
    skill: 'meld-intake-triage',
    slippage: 'fork embellishes truncated resident text into inferred fact',
    verdict: 'edit-existing',
    incident: 'THNRV7CB 2026-06-07 first-live-use',
    confidence: 'high',
  },
};

const SLIM_EVENT = {
  id: '1780959877-dane-rbx62',
  agent: 'dane',
  org: 'ascendops',
  timestamp: '2026-06-08T23:04:37Z',
  category: 'action',
  event: 'forge_candidate',
  severity: 'info',
  metadata: {
    candidate: 'code-review-guard-fails-closed-check',
    confidence: 'high',
    source: 'trending-repo-scout review miss',
    date: '2026-06-08',
  },
};

function seedEvents(agent: string, date: string, events: object[]) {
  const dir = join(eventsRoot, agent);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${date}.jsonl`), events.map((e) => JSON.stringify(e)).join('\n') + '\n', 'utf-8');
}

describe('forge-candidates', () => {
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'forge-cand-'));
    runsDir = join(tmp, 'forge-runs');
    eventsRoot = join(tmp, 'events');
    mkdirSync(eventsRoot, { recursive: true });
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it('emit refuses a candidate with no tied real incident (forge hard rule 1)', () => {
    const res = run(['emit', '--runs-dir', runsDir, '--no-event', '--slippage', 'speculative thing', '--verdict', 'create-new']);
    expect(res.status).toBe(1);
    expect(res.stderr).toContain('REAL incident');
    expect(existsSync(join(runsDir, 'candidates.md'))).toBe(false);
  });

  it('emit appends a durable run-log entry before anything else', () => {
    const res = run([
      'emit', '--runs-dir', runsDir, '--no-event',
      '--skill', 'meld-intake-triage', '--verdict', 'edit-existing',
      '--slippage', 'inferred beyond confirmed text', '--incident', 'THNRV7CB 2026-06-07',
      '--rule', 'never present inference as confirmed fact',
    ]);
    expect(res.status).toBe(0);
    const md = readFileSync(join(runsDir, 'candidates.md'), 'utf-8');
    expect(md).toContain('## Pending');
    expect(md).toContain('- incident: THNRV7CB 2026-06-07');
    expect(md).toContain('- verdict: edit-existing');
  });

  it('queue merges both event metadata shapes with run-log entries and groups by verdict', () => {
    seedEvents('dane', '2026-06-07', [RICH_EVENT]);
    seedEvents('dane', '2026-06-08', [SLIM_EVENT]);
    run([
      'emit', '--runs-dir', runsDir, '--no-event',
      '--skill', 'fleet-consistency-sweep', '--verdict', 'create-new',
      '--slippage', 'same reconcile done by hand 3x', '--incident', 'PR #102 + #106 2026-06-07',
    ]);
    const res = run(['queue', '--runs-dir', runsDir, '--events-root', eventsRoot, '--since', '2026-06-01', '--format', 'json']);
    expect(res.status).toBe(0);
    const queue = JSON.parse(res.stdout);
    expect(queue.total).toBe(3);
    expect(queue.groups['create-new']).toHaveLength(1);
    expect(queue.groups['edit-existing']).toHaveLength(1);
    expect(queue.groups['needs-verdict']).toHaveLength(1); // slim shape has no verdict
    expect(queue.groups['needs-verdict'][0].skill).toBe('code-review-guard-fails-closed-check');
  });

  it('queue dedupes an event already recorded in the run log by event_id', () => {
    seedEvents('dane', '2026-06-07', [RICH_EVENT]);
    mkdirSync(runsDir, { recursive: true });
    writeFileSync(join(runsDir, 'candidates.md'), `# q\n\n## Pending\n\n### fc-1-aaaaa\n- date: 2026-06-07\n- skill: meld-intake-triage\n- verdict: edit-existing\n- incident: THNRV7CB\n- event_id: ${RICH_EVENT.id}\n\n`, 'utf-8');
    const res = run(['queue', '--runs-dir', runsDir, '--events-root', eventsRoot, '--since', '2026-06-01', '--format', 'json']);
    const queue = JSON.parse(res.stdout);
    expect(queue.total).toBe(1);
    expect(queue.groups['edit-existing'][0].id).toBe('fc-1-aaaaa');
  });

  it('queue dedupes the real emit dual-persist (run-log entry + its forge_candidate event share the fc-id)', () => {
    // emit appends the run-log entry keyed by the candidate fc-id and emits a
    // forge_candidate event whose metadata carries that SAME id. The run-log
    // entry has NO event_id (it is written before the bus assigns one), so
    // dedupe must match on the shared fc-id, not event_id, or every emitted
    // candidate is counted twice in the weekly build.
    const FC_ID = 'fc-1780842999-zzzaa';
    seedEvents('dane', '2026-06-07', [{
      id: '1780842999-dane-busid',
      agent: 'dane',
      org: 'ascendops',
      timestamp: '2026-06-07T14:36:39Z',
      category: 'action',
      event: 'forge_candidate',
      severity: 'info',
      metadata: {
        id: FC_ID,
        skill: 'meld-intake-triage',
        slippage: 'inferred beyond confirmed text',
        verdict: 'edit-existing',
        incident: 'THNRV7CB 2026-06-07',
        confidence: 'high',
      },
    }]);
    mkdirSync(runsDir, { recursive: true });
    writeFileSync(join(runsDir, 'candidates.md'),
      `# q\n\n## Pending\n\n### ${FC_ID}\n- date: 2026-06-07\n- skill: meld-intake-triage\n- verdict: edit-existing\n- incident: THNRV7CB 2026-06-07\n\n`,
      'utf-8');
    const res = run(['queue', '--runs-dir', runsDir, '--events-root', eventsRoot, '--since', '2026-06-01', '--format', 'json']);
    const queue = JSON.parse(res.stdout);
    expect(queue.total).toBe(1);
    expect(queue.groups['edit-existing']).toHaveLength(1);
    expect(queue.groups['edit-existing'][0].id).toBe(FC_ID);
  });

  it('consume archives pending entries, resets the queue, and advances the marker', () => {
    seedEvents('dane', '2026-06-07', [RICH_EVENT]);
    run([
      'emit', '--runs-dir', runsDir, '--no-event',
      '--skill', 'x', '--verdict', 'create-new', '--slippage', 's', '--incident', 'PR #1 2026-06-09',
    ]);
    const res = run(['consume', '--runs-dir', runsDir, '--build-id', 'build-test']);
    expect(res.status).toBe(0);
    expect(readFileSync(join(runsDir, 'runs', 'build-test.md'), 'utf-8')).toContain('- incident: PR #1 2026-06-09');
    expect(readFileSync(join(runsDir, 'candidates.md'), 'utf-8')).not.toContain('PR #1');
    const marker = JSON.parse(readFileSync(join(runsDir, '.last-build'), 'utf-8'));
    expect(marker.build_id).toBe('build-test');
    // After consume, the default window starts at consumed_through — the old
    // event no longer re-surfaces on the next build.
    const next = run(['queue', '--runs-dir', runsDir, '--events-root', eventsRoot, '--format', 'json']);
    expect(JSON.parse(next.stdout).total).toBe(0);
  });

  it('consume archives event-only candidates from the merged queue, not just candidates.md (#3)', () => {
    // An externally-emitted forge_candidate event with NO candidates.md run-log
    // entry (instant-on-miss / a direct `log-event forge_candidate`, not via
    // `emit`). The weekly build reads it via the merged queue, so consume must
    // archive it too — otherwise the marker advances past it and the run record
    // silently loses part of what the build processed.
    const today = new Date().toISOString().split('T')[0];
    seedEvents('dane', today, [{
      id: 'busid-evonly',
      agent: 'dane',
      org: 'ascendops',
      // Past-of-cutoff, time-independent. A hardcoded UTC hour flaked when CI ran
      // before that hour (event became future-of-now and got filtered out).
      timestamp: new Date(Date.now() - 60_000).toISOString(),
      category: 'action',
      event: 'forge_candidate',
      severity: 'info',
      metadata: {
        skill: 'ext-skill', slippage: 'direct-logged miss',
        verdict: 'edit-existing', incident: `PR #9 ${today}`, confidence: 'high',
      },
    }]);
    // Intentionally no candidates.md run-log entry (event-only).
    const res = run(['consume', '--runs-dir', runsDir, '--events-root', eventsRoot, '--build-id', 'build-evonly']);
    expect(res.status).toBe(0);
    const archive = readFileSync(join(runsDir, 'runs', 'build-evonly.md'), 'utf-8');
    expect(archive).toContain(`PR #9 ${today}`); // the event-only candidate IS archived
    expect(archive).toContain('Consumed 1 candidate');
  });

  it('snapshot-binds consume to build-start: a candidate emitted AFTER the queue-read survives the next build (TOCTOU)', () => {
    const today = new Date().toISOString().split('T')[0];
    const t1Event = {
      id: 'ev-t1', agent: 'dane', org: 'ascendops', timestamp: new Date(Date.now() - 60_000).toISOString(), // past-of-cutoff, time-independent
      category: 'action', event: 'forge_candidate', severity: 'info',
      metadata: { id: 'fc-t1', skill: 'built-a', slippage: 's', verdict: 'create-new', incident: `PR #1 ${today}`, confidence: 'high' },
    };
    // At build-read time only the T1 candidate exists.
    seedEvents('dane', today, [t1Event]);
    const q1 = JSON.parse(run(['queue', '--runs-dir', runsDir, '--events-root', eventsRoot, '--format', 'json']).stdout);
    expect(q1.total).toBe(1); // queue (no --since) wrote the build-start snapshot

    // The snapshot's build_start_ts is the SAME authoritative pre-read cutoff
    // buildQueue returned (one value threaded into filter + snapshot + watermark).
    const snap = JSON.parse(readFileSync(join(runsDir, '.pending-build.json'), 'utf-8'));
    expect(snap.build_start_ts).toBe(q1.cutoffTs);

    // A RACING candidate lands AFTER the queue-read cutoff but BEFORE consume —
    // a realistic 1 ms past the build-start boundary (not a far-future value,
    // which the upper-bound would correctly exclude from EVERY build). It must be
    // excluded from THIS build and survive into the next.
    const raceTs = new Date(Date.parse(q1.cutoffTs) + 1).toISOString();
    const raceEvent = {
      id: 'ev-race', agent: 'dane', org: 'ascendops', timestamp: raceTs,
      category: 'action', event: 'forge_candidate', severity: 'info',
      metadata: { id: 'fc-race', skill: 'racing-b', slippage: 'landed mid-build', verdict: 'create-new', incident: `PR #2 ${today}`, confidence: 'high' },
    };
    seedEvents('dane', today, [t1Event, raceEvent]);

    // consume archives EXACTLY the snapshot (the T1 candidate), watermark = build-start.
    expect(run(['consume', '--runs-dir', runsDir, '--events-root', eventsRoot, '--build-id', 'build-toctou']).status).toBe(0);
    const archive = readFileSync(join(runsDir, 'runs', 'build-toctou.md'), 'utf-8');
    expect(archive).toContain(`PR #1 ${today}`);     // built candidate archived
    expect(archive).not.toContain(`PR #2 ${today}`); // racing candidate NOT swept in

    // The racing candidate must SURVIVE into the next build (not silently dropped).
    const q2 = JSON.parse(run(['queue', '--runs-dir', runsDir, '--events-root', eventsRoot, '--format', 'json']).stdout);
    const surviving = [...q2.groups['create-new'], ...q2.groups['edit-existing'], ...q2.groups['needs-verdict']].map((e: any) => e.skill);
    expect(q2.total).toBe(1);
    expect(surviving).toContain('racing-b');
  });

  it('excludes events at/after the build-read cutoff (pre-read authoritative upper bound)', () => {
    // The cutoff is captured BEFORE readEvents. An event whose ts is after the
    // read boundary belongs to the NEXT build, not this one — it must not be in
    // the queue (so it cannot be archived-as-consumed by a same-run consume).
    const today = new Date().toISOString().split('T')[0];
    seedEvents('dane', today, [
      { id: 'ev-now', agent: 'dane', org: 'ascendops', timestamp: `${today}T00:00:01Z`, category: 'action', event: 'forge_candidate', severity: 'info', metadata: { id: 'fc-now', skill: 'present', slippage: 's', verdict: 'create-new', incident: `PR #1 ${today}`, confidence: 'high' } },
      { id: 'ev-future', agent: 'dane', org: 'ascendops', timestamp: '2999-01-01T00:00:00Z', category: 'action', event: 'forge_candidate', severity: 'info', metadata: { id: 'fc-future', skill: 'future', slippage: 's', verdict: 'create-new', incident: `PR #2 ${today}`, confidence: 'high' } },
    ]);
    const q = JSON.parse(run(['queue', '--runs-dir', runsDir, '--events-root', eventsRoot, '--format', 'json']).stdout);
    const skills = [...q.groups['create-new'], ...q.groups['edit-existing'], ...q.groups['needs-verdict']].map((e: any) => e.skill);
    expect(skills).toContain('present');
    expect(skills).not.toContain('future'); // ts > cutoff → excluded from THIS build
    expect(q.total).toBe(1);
  });

  it('preserves a candidates.md-only entry appended AFTER the snapshot (no-event silent-drop)', () => {
    // built-c is in the snapshot; postsnap-c lands in candidates.md AFTER the
    // queue-read with --no-event (no bus event to recover it from). consume must
    // remove only the consumed-snapshot id and PRESERVE postsnap-c, not blanket-
    // reset the run log.
    run(['emit', '--runs-dir', runsDir, '--no-event', '--skill', 'built-c', '--verdict', 'create-new', '--slippage', 's', '--incident', 'PR #1 built']);
    const q1 = JSON.parse(run(['queue', '--runs-dir', runsDir, '--events-root', eventsRoot, '--format', 'json']).stdout);
    expect(q1.total).toBe(1); // snapshot captures only built-c

    run(['emit', '--runs-dir', runsDir, '--no-event', '--skill', 'postsnap-c', '--verdict', 'edit-existing', '--slippage', 'late', '--incident', 'PR #2 postsnap']);

    expect(run(['consume', '--runs-dir', runsDir, '--events-root', eventsRoot, '--build-id', 'build-preserve']).status).toBe(0);
    const archive = readFileSync(join(runsDir, 'runs', 'build-preserve.md'), 'utf-8');
    expect(archive).toContain('PR #1 built');        // built-c consumed
    expect(archive).not.toContain('PR #2 postsnap');  // post-snapshot NOT consumed

    // The post-snapshot candidates.md-only entry survives into the next queue.
    const q2 = JSON.parse(run(['queue', '--runs-dir', runsDir, '--events-root', eventsRoot, '--format', 'json']).stdout);
    const skills = [...q2.groups['create-new'], ...q2.groups['edit-existing'], ...q2.groups['needs-verdict']].map((e: any) => e.skill);
    expect(q2.total).toBe(1);
    expect(skills).toContain('postsnap-c');
    expect(skills).not.toContain('built-c');
  });

  it('does not requeue same-UTC-day events after consume (P1 timestamp watermark)', () => {
    // The date-only marker + strict `date < since` file filter re-reads the
    // current day's JSONL after consume resets candidates.md, so a candidate
    // consumed on the SAME UTC day it was emitted would reappear. The precise
    // consumed_through_ts watermark must exclude it. (The other consume test
    // passes only because its events are PAST-dated, never same-day.)
    const today = new Date().toISOString().split('T')[0];
    const earlyToday = `${today}T00:00:01Z`; // strictly before the consume moment
    seedEvents('dane', today, [{
      id: 'busid-sameday',
      agent: 'dane',
      org: 'ascendops',
      timestamp: earlyToday,
      category: 'action',
      event: 'forge_candidate',
      severity: 'info',
      metadata: {
        id: 'fc-sameday-1', skill: 'x', slippage: 's',
        verdict: 'create-new', incident: `PR #1 ${today}`, confidence: 'high',
      },
    }]);
    mkdirSync(runsDir, { recursive: true });
    writeFileSync(join(runsDir, 'candidates.md'),
      `# q\n\n## Pending\n\n### fc-sameday-1\n- date: ${today}\n- skill: x\n- verdict: create-new\n- incident: PR #1 ${today}\n\n`,
      'utf-8');
    // Pre-consume: explicit --since (watermark disabled) sees the candidate once.
    const pre = JSON.parse(run(['queue', '--runs-dir', runsDir, '--events-root', eventsRoot, '--since', today, '--format', 'json']).stdout);
    expect(pre.total).toBe(1);
    // Consume stamps consumed_through_ts = now (after earlyToday).
    expect(run(['consume', '--runs-dir', runsDir, '--build-id', 'build-sameday']).status).toBe(0);
    // Post-consume default queue: same-day file is still in window, but the
    // ts watermark must drop the already-consumed event — total 0, not 1.
    const post = JSON.parse(run(['queue', '--runs-dir', runsDir, '--events-root', eventsRoot, '--format', 'json']).stdout);
    expect(post.total).toBe(0);
  });

  it('queue reports empty cleanly when there is no activity (cost-guard support)', () => {
    const res = run(['queue', '--runs-dir', runsDir, '--events-root', eventsRoot, '--since', '2026-06-01']);
    expect(res.status).toBe(0);
    expect(res.stdout).toContain('Queue is empty');
  });

  // ---- unified-store: candidates.md (run-log) entries bounded by the SAME cutoff
  // as events. emit stamps a precise ISO `emitted_at`; buildQueue windows file
  // entries with `!emitted_at || (> watermark && <= cutoff)`. Closes the prior
  // date-only asymmetry (the second source was unbounded by the authoritative cutoff).

  it('windows candidates.md file entries by emitted_at: excludes > cutoff, keeps in-window AND no-emitted_at (back-compat), and consume preserves the excluded one', () => {
    const today = new Date().toISOString().split('T')[0];
    mkdirSync(runsDir, { recursive: true });
    // present: emitted early today (<= cutoff) → IN. future: emitted_at far ahead
    // (> cutoff) → OUT of every build, must be PRESERVED by consume not archived.
    // legacy: NO emitted_at (written before this change) → kept (back-compat).
    writeFileSync(join(runsDir, 'candidates.md'),
      `# q\n\n## Pending\n\n` +
      `### fc-present\n- date: ${today}\n- emitted_at: ${today}T00:00:01Z\n- skill: present-file\n- verdict: create-new\n- incident: PR #1 ${today}\n\n` +
      `### fc-future\n- date: ${today}\n- emitted_at: 2999-01-01T00:00:00Z\n- skill: future-file\n- verdict: create-new\n- incident: PR #2 ${today}\n\n` +
      `### fc-legacy\n- date: ${today}\n- skill: legacy-file\n- verdict: edit-existing\n- incident: PR #3 ${today}\n\n`,
      'utf-8');
    const q = JSON.parse(run(['queue', '--runs-dir', runsDir, '--events-root', eventsRoot, '--format', 'json']).stdout);
    const skills = [...q.groups['create-new'], ...q.groups['edit-existing'], ...q.groups['needs-verdict']].map((e: any) => e.skill);
    expect(skills).toContain('present-file');
    expect(skills).toContain('legacy-file');     // no emitted_at → kept (back-compat)
    expect(skills).not.toContain('future-file'); // emitted_at > cutoff → deferred
    expect(q.total).toBe(2);

    // consume archives only the build (present + legacy); the > cutoff entry must
    // SURVIVE in candidates.md (preserve-not-drop, the same no-silent-loss invariant).
    expect(run(['consume', '--runs-dir', runsDir, '--events-root', eventsRoot, '--build-id', 'build-ustore']).status).toBe(0);
    const archive = readFileSync(join(runsDir, 'runs', 'build-ustore.md'), 'utf-8');
    expect(archive).toContain(`PR #1 ${today}`);     // present-file consumed
    expect(archive).not.toContain(`PR #2 ${today}`); // future-file NOT swept in
    const remaining = readFileSync(join(runsDir, 'candidates.md'), 'utf-8');
    expect(remaining).toContain('future-file');      // preserved for a later build
    expect(remaining).not.toContain('present-file');
  });

  it('keeps a candidates.md entry whose emit stamp predates the watermark (preserved/no-event entries stay visible — no silent drop)', () => {
    // A file entry can legitimately carry emitted_at <= the marker watermark: it
    // was appended just AFTER a build read, PRESERVED by consume (removed by id,
    // and it was never in the consumed set), while the marker advanced to that
    // build's cutoff. It is still PENDING. The file store has NO watermark lower
    // bound — consume physically removes consumed entries by id, so anything still
    // in candidates.md is by-definition not-yet-consumed and must stay visible.
    // A `--no-event` entry has no event twin to recover it, so dropping it on the
    // lower bound would be a SILENT LOSS (Codex P2 at 44940c1).
    const today = new Date().toISOString().split('T')[0];
    const now = Date.now();
    const watermark = new Date(now - 10_000).toISOString();    // last build's consumed_through_ts
    const oldStamp = new Date(now - 60_000).toISOString();      // predates the watermark
    mkdirSync(runsDir, { recursive: true });
    // Seed the marker so the default-window queue reads the watermark.
    writeFileSync(join(runsDir, '.last-build'),
      `${JSON.stringify({ build_id: 'prev', consumed_through: watermark.split('T')[0], consumed_through_ts: watermark, consumed: 1 })}\n`,
      'utf-8');
    writeFileSync(join(runsDir, 'candidates.md'),
      `# q\n\n## Pending\n\n` +
      `### fc-pres\n- date: ${today}\n- emitted_at: ${oldStamp}\n- skill: preserved-noevent\n- verdict: create-new\n- incident: PR #1 ${today}\n\n`,
      'utf-8');
    const q = JSON.parse(run(['queue', '--runs-dir', runsDir, '--events-root', eventsRoot, '--format', 'json']).stdout);
    const skills = [...q.groups['create-new'], ...q.groups['edit-existing'], ...q.groups['needs-verdict']].map((e: any) => e.skill);
    expect(skills).toContain('preserved-noevent'); // predates watermark but still pending → KEPT
    expect(q.total).toBe(1);
  });

  it('preserves a post-read no-event candidates.md entry across the full preserve cycle, then builds it next round (P2 end-to-end)', () => {
    // End-to-end of the P2 scenario: built-x is in build N's snapshot; postread-x
    // lands in candidates.md AFTER the read (no event). consume archives built-x,
    // PRESERVES postread-x, and advances the watermark past postread-x's stamp.
    // The NEXT build must still surface postread-x (not drop it on the watermark).
    const today = new Date().toISOString().split('T')[0];
    run(['emit', '--runs-dir', runsDir, '--no-event', '--skill', 'built-x', '--verdict', 'create-new', '--slippage', 's', '--incident', 'PR #1 built']);
    const q1 = JSON.parse(run(['queue', '--runs-dir', runsDir, '--events-root', eventsRoot, '--format', 'json']).stdout);
    expect(q1.total).toBe(1); // snapshot captures only built-x

    // postread-x appended after the read, with a stamp BEFORE the build cutoff
    // (it was constructed pre-cutoff, appended post-read) — the exact P2 entry.
    const preCutoffStamp = new Date(Date.parse(q1.cutoffTs) - 1).toISOString();
    writeFileSync(join(runsDir, 'candidates.md'),
      readFileSync(join(runsDir, 'candidates.md'), 'utf-8') +
      `### fc-postread\n- date: ${today}\n- emitted_at: ${preCutoffStamp}\n- skill: postread-x\n- verdict: edit-existing\n- incident: PR #2 postread\n\n`,
      'utf-8');

    expect(run(['consume', '--runs-dir', runsDir, '--events-root', eventsRoot, '--build-id', 'build-p2']).status).toBe(0);
    const archive = readFileSync(join(runsDir, 'runs', 'build-p2.md'), 'utf-8');
    expect(archive).toContain('PR #1 built');        // built-x consumed
    expect(archive).not.toContain('PR #2 postread'); // postread-x NOT consumed

    const q2 = JSON.parse(run(['queue', '--runs-dir', runsDir, '--events-root', eventsRoot, '--format', 'json']).stdout);
    const skills = [...q2.groups['create-new'], ...q2.groups['edit-existing'], ...q2.groups['needs-verdict']].map((e: any) => e.skill);
    expect(skills).toContain('postread-x'); // survives the watermark advance → built next round, not lost
    expect(q2.total).toBe(1);
  });

  it('emit stamps a precise ISO emitted_at that round-trips and lands in-window', () => {
    const res = run(['emit', '--runs-dir', runsDir, '--no-event',
      '--skill', 'roundtrip', '--verdict', 'create-new', '--slippage', 's', '--incident', 'PR #1 rt']);
    expect(res.status).toBe(0);
    const md = readFileSync(join(runsDir, 'candidates.md'), 'utf-8');
    expect(md).toMatch(/- emitted_at: \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z/); // ISO stamped
    // The just-emitted candidate (emitted_at = now-ish) is <= the next queue's
    // cutoff and survives the filter → proves the stamp round-trips through
    // formatEntry/parseQueueFile and passes the window.
    const q = JSON.parse(run(['queue', '--runs-dir', runsDir, '--events-root', eventsRoot, '--format', 'json']).stdout);
    const skills = [...q.groups['create-new'], ...q.groups['edit-existing'], ...q.groups['needs-verdict']].map((e: any) => e.skill);
    expect(skills).toContain('roundtrip');
    expect(q.total).toBe(1);
  });

  it('windows the EVENT on its meta emitted_at, not the bus-assigned ts (closes the emit-stamp straddle)', () => {
    // emit stamps emitted_at at construction, BEFORE the bus event is logged, so
    // ev.timestamp is strictly later. Here the bus ts is in-window (early today)
    // but the candidate's own emit stamp is past the cutoff. The build must defer
    // it on the EMIT STAMP (the same value its run-log twin uses) — windowing on
    // the bus ts (the old bug) would wrongly pull it in and split it from its
    // fileEntry partner across builds.
    const today = new Date().toISOString().split('T')[0];
    seedEvents('dane', today, [{
      id: 'ev-strad', agent: 'dane', org: 'ascendops', timestamp: `${today}T00:00:01Z`,
      category: 'action', event: 'forge_candidate', severity: 'info',
      metadata: { id: 'fc-strad', emitted_at: '2999-01-01T00:00:00Z', skill: 'straddle', slippage: 's', verdict: 'create-new', incident: `PR #1 ${today}`, confidence: 'high' },
    }]);
    const q = JSON.parse(run(['queue', '--runs-dir', runsDir, '--events-root', eventsRoot, '--format', 'json']).stdout);
    const skills = [...q.groups['create-new'], ...q.groups['edit-existing'], ...q.groups['needs-verdict']].map((e: any) => e.skill);
    expect(skills).not.toContain('straddle'); // deferred on meta.emitted_at (> cutoff)
    expect(q.total).toBe(0);
  });

  it('a candidate in BOTH stores with consistent emitted_at builds once and does not re-queue (dual-timestamp race closed)', () => {
    // The run-log entry and its forge_candidate event share id AND emitted_at
    // (early today, both <= cutoff). They must resolve TOGETHER: deduped to one in
    // this build, consumed, and NOT re-queued next build (no straddle duplicate).
    const today = new Date().toISOString().split('T')[0];
    seedEvents('dane', today, [{
      id: 'ev-dup', agent: 'dane', org: 'ascendops', timestamp: `${today}T00:00:02Z`,
      category: 'action', event: 'forge_candidate', severity: 'info',
      metadata: { id: 'fc-dup', emitted_at: `${today}T00:00:01Z`, skill: 'dual-store', slippage: 's', verdict: 'create-new', incident: `PR #1 ${today}`, confidence: 'high' },
    }]);
    mkdirSync(runsDir, { recursive: true });
    writeFileSync(join(runsDir, 'candidates.md'),
      `# q\n\n## Pending\n\n### fc-dup\n- date: ${today}\n- emitted_at: ${today}T00:00:01Z\n- skill: dual-store\n- verdict: create-new\n- incident: PR #1 ${today}\n\n`,
      'utf-8');
    const q1 = JSON.parse(run(['queue', '--runs-dir', runsDir, '--events-root', eventsRoot, '--format', 'json']).stdout);
    expect(q1.total).toBe(1); // deduped across the two stores to ONE

    expect(run(['consume', '--runs-dir', runsDir, '--events-root', eventsRoot, '--build-id', 'build-dual']).status).toBe(0);
    const q2 = JSON.parse(run(['queue', '--runs-dir', runsDir, '--events-root', eventsRoot, '--format', 'json']).stdout);
    expect(q2.total).toBe(0); // not re-queued — no straddle duplicate
  });

  it('back-compat: a no-emitted_at candidate in BOTH stores (legacy) resolves consistently, no split-duplicate', () => {
    // Symmetry check for the fallback path: neither store carries emitted_at. The
    // fileEntry is kept (no stamp to window on); the event falls back to its bus
    // ts. Dedup by id resolves them together → built once, consumed, not
    // re-queued. A legacy event's bus ts is necessarily in the PAST (logged at the
    // original emit), so it can never land > cutoff and split from its fileEntry
    // twin — the back-compat path cannot reintroduce the straddle.
    const today = new Date().toISOString().split('T')[0];
    seedEvents('dane', today, [{
      id: 'ev-leg', agent: 'dane', org: 'ascendops', timestamp: `${today}T00:00:01Z`,
      category: 'action', event: 'forge_candidate', severity: 'info',
      metadata: { id: 'fc-leg', skill: 'legacy-dual', slippage: 's', verdict: 'create-new', incident: `PR #1 ${today}`, confidence: 'high' }, // no emitted_at
    }]);
    mkdirSync(runsDir, { recursive: true });
    writeFileSync(join(runsDir, 'candidates.md'),
      `# q\n\n## Pending\n\n### fc-leg\n- date: ${today}\n- skill: legacy-dual\n- verdict: create-new\n- incident: PR #1 ${today}\n\n`, // no emitted_at
      'utf-8');
    const q1 = JSON.parse(run(['queue', '--runs-dir', runsDir, '--events-root', eventsRoot, '--format', 'json']).stdout);
    expect(q1.total).toBe(1); // deduped to one despite no emitted_at on either side

    expect(run(['consume', '--runs-dir', runsDir, '--events-root', eventsRoot, '--build-id', 'build-leg']).status).toBe(0);
    const q2 = JSON.parse(run(['queue', '--runs-dir', runsDir, '--events-root', eventsRoot, '--format', 'json']).stdout);
    expect(q2.total).toBe(0); // legacy twin consumed once, not re-queued
  });
});
