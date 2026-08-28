import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { HEARTBEAT_SESSION_ENV } from '../../../src/utils/env';
import { logEvent } from '../../../src/bus/event';
import type { BusPaths, Heartbeat } from '../../../src/types';

import { recordSessionNonce } from '../../../src/bus/heartbeat-session-store';
/**
 * Tests for the opt-in heartbeat-refresh side-effect on logEvent. The
 * refresh now happens ONLY when the caller passes
 * `{ refreshHeartbeat: true }`, which is reserved for an agent logging
 * its OWN in-session activity. The default is off (fail-safe): a
 * daemon-on-behalf write (e.g. delivering an inbound message to another
 * agent) never opts in, so a wedged agent's heartbeat cannot be spoofed
 * fresh by traffic it did not act on.
 */
describe('Bus events', () => {
  let testDir: string;
  let paths: BusPaths;

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), 'cortextos-event-test-'));
    paths = {
      ctxRoot: testDir,
      inbox: join(testDir, 'inbox', 'spark'),
      inflight: join(testDir, 'inflight', 'spark'),
      processed: join(testDir, 'processed', 'spark'),
      logDir: join(testDir, 'logs', 'spark'),
      stateDir: join(testDir, 'state', 'spark'),
      taskDir: join(testDir, 'tasks'),
      approvalDir: join(testDir, 'approvals'),
      analyticsDir: join(testDir, 'analytics'),
      heartbeatDir: join(testDir, 'heartbeats'),
    };
    mkdirSync(paths.stateDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  it('logEvent appends a JSONL entry to the daily events file', () => {
    logEvent(paths, 'spark', 'eros-os', 'action', 'test_event', 'info', { foo: 'bar' });

    const today = new Date().toISOString().split('T')[0];
    const eventFile = join(paths.analyticsDir, 'events', 'spark', `${today}.jsonl`);
    expect(existsSync(eventFile)).toBe(true);

    const entries = readFileSync(eventFile, 'utf-8').trim().split('\n').map((l) => JSON.parse(l));
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      agent: 'spark',
      org: 'eros-os',
      category: 'action',
      event: 'test_event',
      severity: 'info',
      metadata: { foo: 'bar' },
    });
  });

  it('scrubs SSNs from the event name and metadata before writing (incl. bare-9 under an ssn key)', () => {
    logEvent(paths, 'spark', 'eros-os', 'action', 'note 123-45-6789', 'info', {
      ssn: '987654321',                     // bare-9, label is the KEY (Codex P1)
      note: 'formatted 123.45.6789 here',   // dotted, inline label
      tenant: 'A. Smith',                   // untouched
      count: 987654321,                     // numeric value left as-is (not a string)
    });

    const today = new Date().toISOString().split('T')[0];
    const eventFile = join(paths.analyticsDir, 'events', 'spark', `${today}.jsonl`);
    const entry = JSON.parse(readFileSync(eventFile, 'utf-8').trim());

    expect(entry.event).toBe('note [REDACTED-SSN]');
    expect(entry.metadata.ssn).toBe('[REDACTED-SSN]');
    expect(entry.metadata.note).toBe('formatted [REDACTED-SSN] here');
    expect(entry.metadata.tenant).toBe('A. Smith');
    expect(entry.metadata.count).toBe(987654321);
  });

  it('redacts an SSN embedded in a metadata KEY, keeping value context (Codex P2b)', () => {
    logEvent(paths, 'spark', 'eros-os', 'action', 'evt', 'info', {
      'tenant 123-45-6789': 'present',
      ssn: '987654321', // value promotes via the original (unredacted) key as labelHint
    });
    const today = new Date().toISOString().split('T')[0];
    const eventFile = join(paths.analyticsDir, 'events', 'spark', `${today}.jsonl`);
    const entry = JSON.parse(readFileSync(eventFile, 'utf-8').trim());

    expect(Object.keys(entry.metadata)).toContain('tenant [REDACTED-SSN]');
    expect(entry.metadata.ssn).toBe('[REDACTED-SSN]');
    expect(JSON.stringify(entry.metadata)).not.toContain('123-45-6789');
    expect(JSON.stringify(entry.metadata)).not.toContain('987654321');
  });

  it('redacts a NUMERIC 9-digit SSN under an ssn-ish key (Codex P2b)', () => {
    logEvent(paths, 'spark', 'eros-os', 'action', 'evt', 'info', {
      ssn: 987654321,        // JSON number, not string — hits the number branch
      count: 987654321,      // same number under a non-SSN key must survive
    });
    const today = new Date().toISOString().split('T')[0];
    const eventFile = join(paths.analyticsDir, 'events', 'spark', `${today}.jsonl`);
    const entry = JSON.parse(readFileSync(eventFile, 'utf-8').trim());
    expect(entry.metadata.ssn).toBe('[REDACTED-SSN]');
    expect(entry.metadata.count).toBe(987654321);
  });

  it('redacts a 9-digit value ONE wrapper level under an ssn-ish key, but not deeper or under a non-ssn key (round-10 P2, depth-1 inheritance)', () => {
    logEvent(paths, 'spark', 'eros-os', 'action', 'evt', 'info', {
      ssn: { value: 987654321 },          // depth-1 under ssn key → redacts (number)
      tax_id: { number: '987654321' },    // depth-1 string under tax-id key → redacts
      ssnList: [{ value: 987654321 }],    // array transparent: object under ssn-ish key → redacts
      deep: { ssn: { a: { b: 987654321 } } }, // number TWO levels under ssn key → NOT promoted
      id: { value: 987654321 },           // non-ssn key → survives
    });
    const today = new Date().toISOString().split('T')[0];
    const eventFile = join(paths.analyticsDir, 'events', 'spark', `${today}.jsonl`);
    const entry = JSON.parse(readFileSync(eventFile, 'utf-8').trim());
    expect(entry.metadata.ssn.value).toBe('[REDACTED-SSN]');
    expect(entry.metadata.tax_id.number).toBe('[REDACTED-SSN]');
    expect(entry.metadata.ssnList[0].value).toBe('[REDACTED-SSN]');
    expect(entry.metadata.deep.ssn.a.b).toBe(987654321); // depth-2 not promoted (conservative)
    expect(entry.metadata.id.value).toBe(987654321);     // non-ssn key survives
  });

  it('inherits ANY PII key (ein/routing/bank) one wrapper down, not just ssn (Codex P1 F6)', () => {
    logEvent(paths, 'spark', 'eros-os', 'action', 'evt', 'info', {
      ein: { value: '123456789' },            // depth-1 under ein key → EIN redacts
      routing_number: { value: '021000021' }, // depth-1 under routing snake_case key → ROUTING redacts
      bank_account: { value: '123456789012' },// depth-1 12-digit under bank key → BANK redacts
      ssn: { value: '987654321' },            // SSN still inherits, byte-identical
      notes: { value: '123456789' },          // non-PII key → NOT over-redacted
    });
    const today = new Date().toISOString().split('T')[0];
    const eventFile = join(paths.analyticsDir, 'events', 'spark', `${today}.jsonl`);
    const entry = JSON.parse(readFileSync(eventFile, 'utf-8').trim());

    expect(entry.metadata.ein.value).toBe('[REDACTED-EIN]');
    expect(entry.metadata.routing_number.value).toBe('[REDACTED-ROUTING]');
    expect(entry.metadata.bank_account.value).toBe('[REDACTED-BANK-ACCT]');
    expect(entry.metadata.ssn.value).toBe('[REDACTED-SSN]'); // SSN unchanged
    expect(entry.metadata.notes.value).toBe('123456789');    // non-PII survives
    // The bank-account 12-digit value must not persist raw anywhere.
    expect(JSON.stringify(entry.metadata)).not.toContain('123456789012');
    expect(JSON.stringify(entry.metadata)).not.toContain('021000021');
  });

  it('PII inheritance stops at one wrapper level (depth-2 under a PII key NOT promoted)', () => {
    logEvent(paths, 'spark', 'eros-os', 'action', 'evt', 'info', {
      ein: { a: { b: '123456789' } },          // TWO levels under ein key → NOT promoted
      bank_account: { a: { b: '123456789012' } }, // depth-2 under bank key → NOT promoted
    });
    const today = new Date().toISOString().split('T')[0];
    const eventFile = join(paths.analyticsDir, 'events', 'spark', `${today}.jsonl`);
    const entry = JSON.parse(readFileSync(eventFile, 'utf-8').trim());
    expect(entry.metadata.ein.a.b).toBe('123456789');         // depth-2 conservative
    expect(entry.metadata.bank_account.a.b).toBe('123456789012');
  });

  it('does NOT over-redact a 9-digit value under an ORGANIC key that substring-contains a label root (Codex round-4 P2 FP)', () => {
    // The metadata-key path must anchor the key->label match (piiLabelKeyHint) and
    // drop the raw `?? keyHint` fallback — else keys like caffEINe_level / routing_table
    // would promote their value via the (intentionally unanchored) labelHint predicate.
    logEvent(paths, 'spark', 'eros-os', 'action', 'evt', 'info', {
      caffeine_level: '123456789',   // contains "ein" — must NOT redact (EIN over-match class)
      vein_count: '123456789',       // contains "ein"
      protein_grams: '123456789',    // contains "ein"
      routing_table: '021000021',    // contains "routing" — must NOT redact (asymmetric routing keeps it out)
      routing_protocol: '021000021', // contains "routing"
    });
    const today = new Date().toISOString().split('T')[0];
    const eventFile = join(paths.analyticsDir, 'events', 'spark', `${today}.jsonl`);
    const entry = JSON.parse(readFileSync(eventFile, 'utf-8').trim());
    expect(entry.metadata.caffeine_level).toBe('123456789');
    expect(entry.metadata.vein_count).toBe('123456789');
    expect(entry.metadata.protein_grams).toBe('123456789');
    expect(entry.metadata.routing_table).toBe('021000021');
    expect(entry.metadata.routing_protocol).toBe('021000021');
  });

  it('still redacts REAL PII keys incl long-buried-label and multi-underscore forms (window-free anchored key match)', () => {
    logEvent(paths, 'spark', 'eros-os', 'action', 'evt', 'info', {
      ein: '123456789',                    // bare root
      ein_number: '123456789',             // snake_case
      ein_number_field: '123456789',       // EIN symmetric boundary allows trailing _ tokens
      employer_ein: '123456789',           // label buried after a prefix
      primary_routing_number: '021000021', // routing label at end, after a prefix
      bank_account_number_v2: '123456789012', // bank multi-underscore
      ssn: '987654321',                    // SSN byte-identical
    });
    const today = new Date().toISOString().split('T')[0];
    const eventFile = join(paths.analyticsDir, 'events', 'spark', `${today}.jsonl`);
    const entry = JSON.parse(readFileSync(eventFile, 'utf-8').trim());
    expect(entry.metadata.ein).toBe('[REDACTED-EIN]');
    expect(entry.metadata.ein_number).toBe('[REDACTED-EIN]');
    expect(entry.metadata.ein_number_field).toBe('[REDACTED-EIN]');
    expect(entry.metadata.employer_ein).toBe('[REDACTED-EIN]');
    expect(entry.metadata.primary_routing_number).toBe('[REDACTED-ROUTING]');
    expect(entry.metadata.bank_account_number_v2).toBe('[REDACTED-BANK-ACCT]');
    expect(entry.metadata.ssn).toBe('[REDACTED-SSN]');
  });

  it('DOCUMENTED LOW residual: a routing label followed by MORE _tokens under-resolves (routing asymmetric trailing; public-id, rare)', () => {
    // routing's asymmetric `(?![a-z0-9_])` (needed to keep routing_table OUT) also blocks
    // `routing_number_suffix` (label + trailing _token). Accepted as LOW (routing #s are
    // public identifiers; rare key shape). The clean V2 fix moves the strict trailing to
    // the bare roots only — a fast-follow with its own in-text re-verify.
    logEvent(paths, 'spark', 'eros-os', 'action', 'evt', 'info', {
      routing_number_suffix: '021000021',
    });
    const today = new Date().toISOString().split('T')[0];
    const eventFile = join(paths.analyticsDir, 'events', 'spark', `${today}.jsonl`);
    const entry = JSON.parse(readFileSync(eventFile, 'utf-8').trim());
    expect(entry.metadata.routing_number_suffix).toBe('021000021'); // residual: stays raw
  });

  describe('heartbeat refresh side-effect', () => {
    it('bumps last_heartbeat on an existing heartbeat.json without overwriting other fields when the caller opts in', async () => {
      // A refresh now requires the agent-session credential as well. This test
      // asserts the ALLOW direction, so it has to stand where a real agent session
      // stands: inside a PTY-minted session. Before the credential existed this
      // line was unnecessary and the guard was fail-OPEN — absence of a marker was
      // enough. Its absence here is what the fail-closed half changed.
      process.env[HEARTBEAT_SESSION_ENV] = 'spark:test-session-nonce-000';
    recordSessionNonce(paths.ctxRoot, 'spark', 'test-session-nonce-000');
      const oldHeartbeat: Heartbeat = {
        agent: 'spark',
        org: 'eros-os',
        status: 'online',
        current_task: 'fix/log-event-refreshes-heartbeat',
        mode: 'day',
        last_heartbeat: '2026-04-23T12:00:00Z',
        loop_interval: '4h',
      };
      writeFileSync(join(paths.stateDir, 'heartbeat.json'), JSON.stringify(oldHeartbeat));

      // Let one millisecond tick so the new timestamp is strictly newer.
      await new Promise((resolve) => setTimeout(resolve, 2));
      logEvent(paths, 'spark', 'eros-os', 'action', 'activity_tick', 'info', undefined, {
        refreshHeartbeat: true,
      });

      const refreshed = JSON.parse(
        readFileSync(join(paths.stateDir, 'heartbeat.json'), 'utf-8'),
      ) as Heartbeat;

      // Timestamp bumped…
      expect(new Date(refreshed.last_heartbeat).getTime()).toBeGreaterThan(
        new Date(oldHeartbeat.last_heartbeat).getTime(),
      );
      // …other fields preserved intact.
      expect(refreshed.status).toBe('online');
      expect(refreshed.current_task).toBe('fix/log-event-refreshes-heartbeat');
      expect(refreshed.mode).toBe('day');
      expect(refreshed.loop_interval).toBe('4h');
      expect(refreshed.agent).toBe('spark');
      expect(refreshed.org).toBe('eros-os');
    });

    it('leaves last_heartbeat byte-identical when the caller does not opt in (default off, spoof-safe)', () => {
      const oldHeartbeat: Heartbeat = {
        agent: 'spark',
        org: 'eros-os',
        status: 'online',
        current_task: 'wedged',
        mode: 'day',
        last_heartbeat: '2026-04-23T12:00:00Z',
        loop_interval: '4h',
      };
      const raw = JSON.stringify(oldHeartbeat);
      writeFileSync(join(paths.stateDir, 'heartbeat.json'), raw);

      // Daemon-on-behalf-style write: no opts, so no refresh.
      logEvent(paths, 'spark', 'eros-os', 'message', 'telegram_received', 'info', { text_chars: 3 });

      const after = readFileSync(join(paths.stateDir, 'heartbeat.json'), 'utf-8');
      expect(after).toBe(raw);
    });

    it('is a no-op when no heartbeat.json exists yet', () => {
      // Fresh agent — no heartbeat file written yet.
      expect(existsSync(join(paths.stateDir, 'heartbeat.json'))).toBe(false);

      logEvent(paths, 'spark', 'eros-os', 'action', 'first_boot', 'info');

      // Still no heartbeat file — refresh is a no-op when nothing exists.
      expect(existsSync(join(paths.stateDir, 'heartbeat.json'))).toBe(false);

      // But the event itself was written.
      const today = new Date().toISOString().split('T')[0];
      const eventFile = join(paths.analyticsDir, 'events', 'spark', `${today}.jsonl`);
      expect(existsSync(eventFile)).toBe(true);
    });

    it('never blocks event persistence when the heartbeat refresh fails', () => {
      // Write a corrupt heartbeat.json to exercise the error path.
      writeFileSync(join(paths.stateDir, 'heartbeat.json'), '{not valid json');

      // Must not throw. Opt in so the refresh path is actually exercised.
      expect(() =>
        logEvent(paths, 'spark', 'eros-os', 'action', 'after_corrupt_hb', 'info', undefined, {
          refreshHeartbeat: true,
        }),
      ).not.toThrow();

      // Event still written.
      const today = new Date().toISOString().split('T')[0];
      const eventFile = join(paths.analyticsDir, 'events', 'spark', `${today}.jsonl`);
      const entries = readFileSync(eventFile, 'utf-8').trim().split('\n');
      expect(entries).toHaveLength(1);
    });
  });
});
