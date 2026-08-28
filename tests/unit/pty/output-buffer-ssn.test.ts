import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// Mirror output-buffer.test.ts: mock fs.appendFileSync so the disk log writes
// are captured rather than hitting disk.
const appendFileSyncMock = vi.fn();
vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs');
  return {
    ...actual,
    appendFileSync: (...args: unknown[]) => appendFileSyncMock(...args),
  };
});

const { OutputBuffer } = await import('../../../src/pty/output-buffer');

const SSN_PLACEHOLDER = '[REDACTED-SSN]';

/** Concatenate everything written to the disk log across all commits. */
function diskLog(): string {
  return appendFileSyncMock.mock.calls.map((c) => String(c[1])).join('');
}

beforeEach(() => {
  appendFileSyncMock.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('OutputBuffer — SSN redaction', () => {
  it('redacts a complete formatted SSN in a single chunk', () => {
    const buf = new OutputBuffer(1000, '/tmp/fake-stdout.log');
    buf.push('tenant ssn 123-45-6789 on file\n');
    const log = diskLog();
    expect(log).toContain(SSN_PLACEHOLDER);
    expect(log).not.toContain('123-45-6789');
  });

  it('redacts a context-keyed SSN in a single chunk', () => {
    const buf = new OutputBuffer(1000, '/tmp/fake-stdout.log');
    buf.push('SSN: 987654321\n');
    const log = diskLog();
    expect(log).toContain(SSN_PLACEHOLDER);
    expect(log).not.toContain('987654321');
  });

  it('reassembles + redacts a formatted SSN split across two chunks', () => {
    const buf = new OutputBuffer(1000, '/tmp/fake-stdout.log');
    buf.push('tenant 123-45');   // partial SSN held back
    buf.push('-6789 done');      // completes the SSN; trailing 'e' held as a
                                 // possible JWT prefix (pre-existing behavior)
    buf.close();                 // flushes the bare 'e' verbatim
    const log = diskLog();
    expect(log).toBe(`tenant ${SSN_PLACEHOLDER} done`);
    expect(log).not.toContain('123-45-6789');
  });

  it('reassembles + redacts a DOTTED SSN split across two chunks (F5)', () => {
    const buf = new OutputBuffer(1000, '/tmp/fake-stdout.log');
    buf.push('tenant 123.45');
    buf.push('.6789 done');
    buf.close(); // flush trailing 'e' held as a JWT prefix
    const log = diskLog();
    expect(log).toBe(`tenant ${SSN_PLACEHOLDER} done`);
    expect(log).not.toContain('123.45.6789');
  });

  it('reassembles an SSN split INSIDE the first group, 12|3-45-6789 (F2)', () => {
    const buf = new OutputBuffer(1000, '/tmp/fake-stdout.log');
    buf.push('acct 12');     // first-group fragment held back
    buf.push('3-45-6789 z');
    const log = diskLog();
    expect(log).toBe(`acct ${SSN_PLACEHOLDER} z`);
    expect(log).not.toContain('123-45-6789');
  });

  it('does NOT redact a phone number split across two chunks (0-FP)', () => {
    const buf = new OutputBuffer(1000, '/tmp/fake-stdout.log');
    buf.push('call 423-555');
    buf.push('-0100 now');
    // Flush any held tail so the full phone is in the log.
    buf.close();
    const log = diskLog();
    expect(log).toContain('423-555-0100');
    expect(log).not.toContain(SSN_PLACEHOLDER);
  });

  it('close() masks a held partial-SSN tail rather than leaking it', () => {
    const buf = new OutputBuffer(1000, '/tmp/fake-stdout.log');
    buf.push('member 123-45-67'); // partial SSN held back at end of stream
    buf.close();
    const log = diskLog();
    expect(log).not.toContain('123-45-67');
    expect(log).toContain('[REDACTED_POSSIBLE_SSN_TAIL]');
  });

  it('close() emits a bare trailing digit run verbatim (no over-masking)', () => {
    const buf = new OutputBuffer(1000, '/tmp/fake-stdout.log');
    buf.push('page 123'); // bare 3-digit tail held only as a possible SSN prefix
    buf.close();
    const log = diskLog();
    expect(log).toBe('page 123');
  });

  it('close() emits a newline-terminated counter verbatim, not a JWT mask (Codex P2)', () => {
    const buf = new OutputBuffer(1000, '/tmp/fake-stdout.log');
    buf.push('exit 123\n'); // holdback grabs `123\n` (\n is in the separator class)
    buf.close();
    const log = diskLog();
    expect(log).toBe('exit 123\n');
    expect(log).not.toContain('[REDACTED_POSSIBLE_JWT_TAIL]');
  });

  it('redacts a complete JWT whose tail is an SSN-partial digit run, no reconstruction (Codex P1, redact-first)', () => {
    const buf = new OutputBuffer(1000, '/tmp/fake-stdout.log');
    // Complete JWT (each segment >= 10 chars) ending in `-123`. The SSN
    // partial-holdback would grab the trailing `123`, leaving an unmatched JWT
    // prefix — UNLESS complete tokens are redacted before the holdback runs.
    const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ0ZXN0LWlkIn0.abcdef-123';
    buf.push(`token=${jwt}`);
    buf.close();
    const log = diskLog();
    expect(log).toContain('[REDACTED_JWT]');
    expect(log).not.toContain(jwt);
    expect(log).not.toContain('abcdef-123'); // no reconstruction across the boundary
  });

  it('still redacts a complete JWT split across chunks AND reassembles a split SSN (no regression)', () => {
    const buf = new OutputBuffer(1000, '/tmp/fake-stdout.log');
    buf.push('ssn 123-45');           // partial SSN held
    buf.push('-6789 done');           // completes + redacts; trailing 'e' held as JWT prefix
    buf.close();                      // flush the bare 'e' verbatim
    const log = diskLog();
    expect(log).toBe(`ssn ${SSN_PLACEHOLDER} done`);
  });

  it('getRecent() masks a held PARTIAL SSN tail so pollers never see it (Codex P2a)', () => {
    const buf = new OutputBuffer(1000, '/tmp/fake-stdout.log');
    buf.push('member 123-45-67'); // partial SSN material held back (incomplete)
    const recent = buf.getRecent();
    expect(recent).not.toContain('123-45-67');
    expect(recent).toContain('[REDACTED_POSSIBLE_SSN_TAIL]');
  });

  it('getRecent() shows the redacted form for a same-chunk SSN', () => {
    const buf = new OutputBuffer(1000, '/tmp/fake-stdout.log');
    buf.push('ssn 111-22-3333 here\n');
    const recent = buf.getRecent();
    expect(recent).toContain(SSN_PLACEHOLDER);
    expect(recent).not.toContain('111-22-3333');
  });

  // ----- round-10: label-context split across the chunk boundary -----

  it('reassembles a context-keyed SSN whose LABEL and NUMBER split across chunks (round-10 P1, label-region holdback)', () => {
    const buf = new OutputBuffer(1000, '/tmp/fake-stdout.log');
    buf.push('member SSN: ');   // label held back so its number reassembles with it
    buf.push('987654321 end');
    buf.close();
    const log = diskLog();
    // The label is not itself secret — only the NUMBER is replaced.
    expect(log).toBe(`member SSN: ${SSN_PLACEHOLDER} end`);
    expect(log).not.toContain('987654321');
  });

  it('reassembles a context-keyed SSN with the label split from its number by a NEWLINE across chunks (round-10, newline gap)', () => {
    const buf = new OutputBuffer(1000, '/tmp/fake-stdout.log');
    buf.push('social security number\n'); // label + trailing newline held
    buf.push('987654321 z');
    buf.close();
    const log = diskLog();
    expect(log).toContain(SSN_PLACEHOLDER);
    expect(log).not.toContain('987654321');
  });

  it('reassembles a context-keyed SSN whose LABEL TOKEN is split mid-token, SS|N (round-10, mid-label split)', () => {
    const buf = new OutputBuffer(1000, '/tmp/fake-stdout.log');
    buf.push('member SS');        // mid-label cut — held as a label prefix
    buf.push('N: 987654321 end');
    buf.close();
    const log = diskLog();
    // The reassembled label (SSN:) stays; only the number is redacted.
    expect(log).toBe(`member SSN: ${SSN_PLACEHOLDER} end`);
    expect(log).not.toContain('987654321');
  });

  it('reassembles a context-keyed SSN with a LONG label split mid-token, socia|l security (round-10, mid-label split)', () => {
    const buf = new OutputBuffer(1000, '/tmp/fake-stdout.log');
    buf.push('record socia');
    buf.push('l security 987654321 done');
    buf.close();
    const log = diskLog();
    expect(log).toContain(SSN_PLACEHOLDER);
    expect(log).not.toContain('987654321');
  });

  it('reassembles a context-keyed SSN with tax-id split mid-token, tax i|d (round-10, mid-label split)', () => {
    const buf = new OutputBuffer(1000, '/tmp/fake-stdout.log');
    buf.push('ref tax i');
    buf.push('d 987654321 x');
    buf.close();
    const log = diskLog();
    expect(log).toContain(SSN_PLACEHOLDER);
    expect(log).not.toContain('987654321');
  });

  it('does NOT lose or mask ordinary words that end in a label prefix — held then re-emitted (round-10, FP-safe by construction)', () => {
    const buf = new OutputBuffer(1000, '/tmp/fake-stdout.log');
    // Each chunk ends in a label-prefix substring (ss / ta / so) so the prefix
    // holdback grabs the tail; the next chunk fails to form a label+number, so
    // every byte is re-emitted intact and nothing is redacted.
    buf.push('busine');
    buf.push('ss data');  // 'ss' from chunk 1 + 'data' tail 'ta' held next
    buf.push(' also so');
    buf.push('on enough'); // flush the held 'so'
    buf.close();
    const log = diskLog();
    expect(log).toBe('business data also soon enough');
    expect(log).not.toContain('REDACTED');
  });

  it('close() flushes a held no-digit label prefix verbatim at stream end (round-10, no over-mask)', () => {
    const buf = new OutputBuffer(1000, '/tmp/fake-stdout.log');
    buf.push('the value is ss'); // 'ss' held as a possible SSN-label prefix
    buf.close();                 // stream ends before any number arrives
    const log = diskLog();
    expect(log).toBe('the value is ss');
    expect(log).not.toContain('REDACTED');
  });

  // ----- #25: invisible-laced formatted SSN split across a chunk boundary -----
  // The formatted holdback (PARTIAL_SSN_AT_END / COMPLETE_SSN) is now INVIS-aware,
  // so a `1<ZWSP>23-45-67` | `89` split is HELD and reassembled, matching what the
  // same-chunk Pass-2 matcher would catch. (Whole-string redaction is covered by
  // the matcher tests; this is the JS-only STREAMING path the parity fuzz never
  // exercises.)
  const ZWSP = '\u200b';

  it('holds + reassembles an invisible-laced formatted SSN split across chunks (#25)', () => {
    const buf = new OutputBuffer(1000, '/tmp/fake-stdout.log');
    buf.push(`pre 1${ZWSP}23-45-67`); // invisible-laced partial held back
    buf.push('89 post');
    buf.close();
    const log = diskLog();
    expect(log).toContain(SSN_PLACEHOLDER);
    expect(log).not.toContain('23-45-6789');
  });

  it('holds an invisible split inside the LAST group (123-45-|67<ZWSP>89) (#25)', () => {
    const buf = new OutputBuffer(1000, '/tmp/fake-stdout.log');
    buf.push('acct 123-45-');
    buf.push(`67${ZWSP}89 z`);
    buf.close();
    const log = diskLog();
    expect(log).toContain(SSN_PLACEHOLDER);
    expect(log).not.toContain('6789');
  });

  it('holds an invisible sitting AT the chunk boundary (123-45<ZWSP>|-6789) (#25)', () => {
    const buf = new OutputBuffer(1000, '/tmp/fake-stdout.log');
    buf.push(`ssn 123-45${ZWSP}`);
    buf.push('-6789 end');
    buf.close();
    expect(diskLog()).toContain(SSN_PLACEHOLDER);
  });

  it('does NOT over-hold a non-SSN numeric split (#25 FP guard)', () => {
    const buf = new OutputBuffer(1000, '/tmp/fake-stdout.log');
    buf.push('price 12');
    buf.push('34 dollars');
    buf.close();
    expect(diskLog()).toBe('price 1234 dollars');
  });

  it('does NOT redact a phone split across chunks even invisible-aware (#25 0-FP)', () => {
    const buf = new OutputBuffer(1000, '/tmp/fake-stdout.log');
    buf.push('call 423-555');
    buf.push('-0100 now');
    buf.close();
    const log = diskLog();
    expect(log).toContain('423-555-0100');
    expect(log).not.toContain(SSN_PLACEHOLDER);
  });
});

// ===========================================================================
// PII v2 m2 — streaming chunk-split holdback for the NEW registry entries
// (EIN, routing, bank-account). Mirrors the SSN split-at-every-boundary pattern
// (the 25th-finding template). For each labeled value, split at EVERY boundary
// position, feed the two chunks through push(), close(), and assert: the value
// NEVER appears raw in the simulated disk sink, the value's placeholder DOES
// appear, and close() flushes a redacted-or-clean (never raw) tail. Plus
// no-over-hold (same-chunk redacts), FP-safety, and invisible-laced splits.
// ===========================================================================
describe('OutputBuffer — PII v2 m2 new-entry streaming holdback (EIN/routing/bank)', () => {
  const EIN_PLACEHOLDER = '[REDACTED-EIN]';
  const ROUTING_PLACEHOLDER = '[REDACTED-ROUTING]';
  const BANK_PLACEHOLDER = '[REDACTED-BANK-ACCT]';
  const ZWSP = '​';

  // Each case: the full labeled line, the RAW value that must never leak, and the
  // placeholder the redaction produces. Split at every boundary 1..len-1.
  const splitCases: Array<{ name: string; line: string; raw: string; placeholder: string }> = [
    { name: 'routing 021000021', line: 'routing 021000021 end', raw: '021000021', placeholder: ROUTING_PLACEHOLDER },
    { name: 'aba 021000021', line: 'aba 021000021 end', raw: '021000021', placeholder: ROUTING_PLACEHOLDER },
    { name: 'bank account 123456789012', line: 'bank account 123456789012 end', raw: '123456789012', placeholder: BANK_PLACEHOLDER },
    { name: 'account number 12345678', line: 'account number 12345678 end', raw: '12345678', placeholder: BANK_PLACEHOLDER },
    { name: 'EIN 12-3456789', line: 'EIN 12-3456789 end', raw: '12-3456789', placeholder: EIN_PLACEHOLDER },
    { name: 'employer identification 98-7654321', line: 'employer identification 98-7654321 end', raw: '98-7654321', placeholder: EIN_PLACEHOLDER },
  ];

  for (const { name, line, raw, placeholder } of splitCases) {
    it(`holds + redacts "${name}" at EVERY chunk-split boundary, never leaks raw`, () => {
      for (let i = 1; i < line.length; i++) {
        const buf = new OutputBuffer(1000, '/tmp/fake-stdout.log');
        buf.push(line.slice(0, i));
        buf.push(line.slice(i));
        buf.close();
        const log = diskLog();
        expect(log, `split at ${i} (${JSON.stringify(line.slice(0, i))}|${JSON.stringify(line.slice(i))}) leaked raw value`).not.toContain(raw);
        expect(log, `split at ${i} missing placeholder`).toContain(placeholder);
        // No loss / no over-hold: the trailing " end" marker survives intact.
        expect(log, `split at ${i} dropped trailing context`).toContain('end');
        appendFileSyncMock.mockReset();
      }
    });
  }

  it('same-chunk new-entry input still redacts (no over-hold of a complete value)', () => {
    for (const { line, raw, placeholder } of splitCases) {
      const buf = new OutputBuffer(1000, '/tmp/fake-stdout.log');
      buf.push(line);
      buf.close();
      const log = diskLog();
      expect(log).not.toContain(raw);
      expect(log).toContain(placeholder);
      appendFileSyncMock.mockReset();
    }
  });

  it('close() flushes a held formatted-EIN partial as a redacted tail (never raw, never dropped)', () => {
    const buf = new OutputBuffer(1000, '/tmp/fake-stdout.log');
    buf.push('employer id 12-34'); // partial formatted-EIN held at stream end
    buf.close();
    const log = diskLog();
    expect(log).not.toContain('12-34');
    expect(log).toContain('[REDACTED_POSSIBLE_EIN_TAIL]');
  });

  it('close() flushes a held no-digit new-entry label region verbatim (no over-mask)', () => {
    const buf = new OutputBuffer(1000, '/tmp/fake-stdout.log');
    buf.push('the routing '); // complete label held, stream ends before the number
    buf.close();
    const log = diskLog();
    expect(log).toBe('the routing ');
    expect(log).not.toContain('REDACTED');
  });

  it('does NOT lose or mask ordinary words ending in a new-entry label prefix — held then re-emitted', () => {
    const buf = new OutputBuffer(1000, '/tmp/fake-stdout.log');
    // 'routi' is a label-prefix; reassembly fails to form a label+value so every
    // byte is re-emitted intact and nothing is redacted.
    buf.push('the routi');
    buf.push('ne checkup done'); // 'routine', not 'routing'
    buf.close();
    const log = diskLog();
    expect(log).toBe('the routine checkup done');
    expect(log).not.toContain('REDACTED');
  });

  it('does NOT over-hold an UNLABELED numeric split (no FP)', () => {
    const buf = new OutputBuffer(1000, '/tmp/fake-stdout.log');
    buf.push('invoice 12345');
    buf.push('678 total'); // 8-digit run, NO bank/routing/ein label nearby
    buf.close();
    const log = diskLog();
    expect(log).toBe('invoice 12345678 total');
    expect(log).not.toContain('REDACTED');
  });

  it('does NOT redact a routing-like 9-digit run with NO label split across chunks (FP guard)', () => {
    const buf = new OutputBuffer(1000, '/tmp/fake-stdout.log');
    buf.push('ref 021000');
    buf.push('021 end'); // bare-9, no label — conservative mode leaves it alone
    buf.close();
    const log = diskLog();
    expect(log).toContain('021000021');
    expect(log).not.toContain(ROUTING_PLACEHOLDER);
  });

  it('holds + reassembles an invisible-laced labeled bank-acct split across chunks', () => {
    // label + invisible-laced value split; label-region hold keeps the label with
    // the value so the conservative bank pass fires on reassembly.
    const buf = new OutputBuffer(1000, '/tmp/fake-stdout.log');
    buf.push('bank account 1234');
    buf.push(`5678${ZWSP}9012 end`);
    buf.close();
    const log = diskLog();
    expect(log).not.toContain('123456789012');
    expect(log).toContain(BANK_PLACEHOLDER);
  });

  it('holds an invisible-laced formatted EIN split across chunks', () => {
    const buf = new OutputBuffer(1000, '/tmp/fake-stdout.log');
    buf.push(`EIN 12-34${ZWSP}5`);
    buf.push('6789 end');
    buf.close();
    const log = diskLog();
    expect(log).not.toContain('3456789');
    expect(log).toContain(EIN_PLACEHOLDER);
  });

  it('label split from its value by a NEWLINE across chunks still reassembles (routing)', () => {
    const buf = new OutputBuffer(1000, '/tmp/fake-stdout.log');
    buf.push('routing\n'); // label + newline gap held
    buf.push('021000021 z');
    buf.close();
    const log = diskLog();
    expect(log).not.toContain('021000021');
    expect(log).toContain(ROUTING_PLACEHOLDER);
  });
});
