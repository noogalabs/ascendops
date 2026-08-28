import { describe, it, expect } from 'vitest';
import {
  redactSSN,
  redactSSNMarkupAware,
  detectSSN,
  splitTrailingPartialSsn,
  isPartialSsnMaterial,
  SSN_PLACEHOLDER,
  LABEL_SEP,
} from '../../../src/utils/ssn-redaction';
import { redactSecrets } from '../../../src/pty/redact';
import corpus from '../../fixtures/ssn-corpus.json';

// Synthetic JWT (same shape as the PTY redactor's tests) used to prove SSN
// redaction does not regress JWT redaction when both run in redactSecrets.
const FAKE_JWT =
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJ0ZXN0LXNlc3Npb24taWQifQ.abcdefghij_-abcdefghij';

// Shared matcher corpus — the SAME file is asserted by the Python mmrag mirror
// (knowledge-base/scripts/test_scrub_ssn.py), so JS/Python stay in lockstep.
// Each case pins the exact conservative-mode output AND idempotency, so matcher
// edge cases (long labels, far-label-for-another-number, double-scrub) are a
// standing regression — they cannot reappear without failing here.
describe('redactSSN — shared corpus (matcher regression proof)', () => {
  for (const c of (corpus as { cases: Array<{ name: string; input: string; expect: string }> }).cases) {
    it(`corpus: ${c.name}`, () => {
      expect(redactSSN(c.input)).toBe(c.expect);
    });
  }

  it('PROPERTY: redactSSN is idempotent across the entire corpus — redact(redact(x)) === redact(x)', () => {
    for (const c of (corpus as { cases: Array<{ input: string }> }).cases) {
      const once = redactSSN(c.input);
      expect(redactSSN(once)).toBe(once);
    }
  });
});

describe('redactSSN — formatted', () => {
  it('redacts dash-separated SSN', () => {
    expect(redactSSN('123-45-6789')).toBe(SSN_PLACEHOLDER);
  });

  it('redacts space-separated SSN', () => {
    expect(redactSSN('123 45 6789')).toBe(SSN_PLACEHOLDER);
  });

  it('leaves surrounding text intact', () => {
    expect(redactSSN('Tenant SSN is 123-45-6789, on file.')).toBe(
      `Tenant SSN is ${SSN_PLACEHOLDER}, on file.`,
    );
  });

  it('redacts multiple SSNs in one string', () => {
    const out = redactSSN('a 123-45-6789 b 987-65-4321 c');
    expect(out).toBe(`a ${SSN_PLACEHOLDER} b ${SSN_PLACEHOLDER} c`);
  });

  it('redacts a dotted SSN (F1)', () => {
    expect(redactSSN('123.45.6789')).toBe(SSN_PLACEHOLDER);
    expect(redactSSN('Tenant SSN 123.45.6789 on file')).toBe(`Tenant SSN ${SSN_PLACEHOLDER} on file`);
  });

  it('does NOT over-redact an unrelated 9-digit ID next to a formatted SSN (placeholder-as-label FP)', () => {
    // Regression for the two-pass ordering bug: the [REDACTED-SSN] placeholder
    // contains "SSN", which must NOT promote a nearby unrelated bare-9 ID.
    expect(redactSSN('Value 123-45-6789 id 987654321')).toBe('Value [REDACTED-SSN] id 987654321');
    expect(redactSSN('ssn 111111111 and 123-45-6789 id 987654321'))
      .toBe(`ssn ${SSN_PLACEHOLDER} and ${SSN_PLACEHOLDER} id 987654321`);
  });

  it('does NOT match a dotted phone / IP / version / decimal (dotted-FP guard)', () => {
    for (const s of ['423.555.0100', '192.168.10.1', '255.255.255.255', 'v1.20.300', '3.14159 pi', '$1,234.56', '2024.05.16']) {
      expect(redactSSN(s)).toBe(s);
    }
  });

  it('does NOT match three unrelated numbers across newlines (horizontal-sep only)', () => {
    expect(redactSSN('123\n45\n6789')).toBe('123\n45\n6789');      // Unix
    expect(redactSSN('123\r\n45\r\n6789')).toBe('123\r\n45\r\n6789'); // Windows
    // ...but a tab-separated single-line SSN IS caught.
    expect(redactSSN('123\t45\t6789')).toBe(SSN_PLACEHOLDER);
  });
});

describe('redactSSN — aggressive env flag (Codex P2)', () => {
  it('honors SSN_REDACT_AGGRESSIVE=1 without an explicit opt', () => {
    const prev = process.env.SSN_REDACT_AGGRESSIVE;
    process.env.SSN_REDACT_AGGRESSIVE = '1';
    try {
      expect(redactSSN('order 987654321 shipped')).toBe(`order ${SSN_PLACEHOLDER} shipped`);
    } finally {
      if (prev === undefined) delete process.env.SSN_REDACT_AGGRESSIVE;
      else process.env.SSN_REDACT_AGGRESSIVE = prev;
    }
  });

  it('defaults conservative when the flag is unset', () => {
    const prev = process.env.SSN_REDACT_AGGRESSIVE;
    delete process.env.SSN_REDACT_AGGRESSIVE;
    try {
      expect(redactSSN('order 987654321 shipped')).toBe('order 987654321 shipped');
    } finally {
      if (prev !== undefined) process.env.SSN_REDACT_AGGRESSIVE = prev;
    }
  });
});

describe('redactSSN — context-keyed bare 9-digit', () => {
  it('redacts "SSN: 987654321"', () => {
    expect(redactSSN('SSN: 987654321')).toBe(`SSN: ${SSN_PLACEHOLDER}`);
  });

  it('redacts "social security 987654321"', () => {
    expect(redactSSN('social security 987654321')).toBe(`social security ${SSN_PLACEHOLDER}`);
  });

  it('redacts "social_security 987654321"', () => {
    expect(redactSSN('social_security 987654321')).toBe(`social_security ${SSN_PLACEHOLDER}`);
  });

  it('redacts "tax id: 123456789"', () => {
    expect(redactSSN('tax id: 123456789')).toBe(`tax id: ${SSN_PLACEHOLDER}`);
  });

  it('redacts when the label FOLLOWS the number (both directions)', () => {
    expect(redactSSN('123456789 is the SSN')).toBe(`${SSN_PLACEHOLDER} is the SSN`);
  });

  it('is case-insensitive on the label', () => {
    expect(redactSSN('Social Security 987654321')).toBe(`Social Security ${SSN_PLACEHOLDER}`);
  });
});

describe('redactSSN — conservative vs aggressive', () => {
  it('conservative: does NOT redact a bare 9-digit run with no nearby label', () => {
    expect(redactSSN('order number 987654321 shipped')).toBe('order number 987654321 shipped');
  });

  it('conservative: a far-away label (>20 chars) does NOT promote', () => {
    // "ssn" is well beyond the 20-char window from the number.
    const text = 'ssn .................................... 987654321';
    expect(redactSSN(text)).toBe(text);
  });

  it('aggressive: redacts any bare 9-digit run', () => {
    expect(redactSSN('order number 987654321 shipped', { aggressive: true })).toBe(
      `order number ${SSN_PLACEHOLDER} shipped`,
    );
  });
});

describe('redactSSN — false-positive guards (0-FP requirement)', () => {
  it('does NOT redact a 10-digit phone XXX-XXX-XXXX', () => {
    expect(redactSSN('Call Alex at 423-555-0100 anytime')).toBe('Call Alex at 423-555-0100 anytime');
  });

  it('does NOT redact a dotted phone or dollar amounts', () => {
    expect(redactSSN('423.555.0100 and $123,456.78')).toBe('423.555.0100 and $123,456.78');
  });

  it('does NOT redact a street address or unit number', () => {
    const t = 'Unit 123, 4567 Maple Ave, zip 37402';
    expect(redactSSN(t)).toBe(t);
  });

  it('does NOT mistake a 10-digit phone for the XXX-XX-XXXX shape', () => {
    // The middle group of a phone is 3 digits; SSN needs 2. \b boundaries hold.
    expect(detectSSN('423-555-0100')).toBe(false);
  });
});

describe('redactSSN — labelHint (out-of-band key context, Codex P1)', () => {
  it('redacts a bare-9 value when the labelHint is an SSN label', () => {
    expect(redactSSN('987654321', { labelHint: 'ssn' })).toBe(SSN_PLACEHOLDER);
    expect(redactSSN('123456789', { labelHint: 'tax_id' })).toBe(SSN_PLACEHOLDER);
  });

  it('does NOT redact a bare-9 value when the labelHint is not an SSN label', () => {
    for (const k of ['count', 'id', 'account', 'order_id', undefined]) {
      expect(redactSSN('987654321', { labelHint: k })).toBe('987654321');
    }
  });

  it('still redacts a formatted SSN value regardless of labelHint', () => {
    expect(redactSSN('123-45-6789', { labelHint: 'whatever' })).toBe(SSN_PLACEHOLDER);
  });
});

describe('detectSSN', () => {
  it('true for a formatted SSN', () => {
    expect(detectSSN('see 123-45-6789')).toBe(true);
  });
  it('true for a context-keyed SSN', () => {
    expect(detectSSN('SSN 987654321')).toBe(true);
  });
  it('false for clean text', () => {
    expect(detectSSN('no secrets here, call 423-555-0100')).toBe(false);
  });
  it('false for a bare 9-digit ID (conservative)', () => {
    expect(detectSSN('id 987654321')).toBe(false);
  });
});

describe('splitTrailingPartialSsn — chunk-boundary holdback', () => {
  it('holds a trailing partial formatted SSN', () => {
    const [emit, hold] = splitTrailingPartialSsn('prefix 123-45-67');
    expect(hold).toBe('123-45-67');
    expect(emit).toBe('prefix ');
  });

  it('holds a trailing 3-digit run (could be the start of an SSN)', () => {
    const [emit, hold] = splitTrailingPartialSsn('value 123');
    expect(hold).toBe('123');
    expect(emit).toBe('value ');
  });

  it('holds EVERY proper prefix incl. split-in-first-group + trailing separator (F2/Codex P1)', () => {
    // 1, 12 (split inside the first group); 123-, 123-45- (split after a separator)
    expect(splitTrailingPartialSsn('acct 1')[1]).toBe('1');
    expect(splitTrailingPartialSsn('acct 12')[1]).toBe('12');
    expect(splitTrailingPartialSsn('x 123-')[1]).toBe('123-');
    expect(splitTrailingPartialSsn('x 123-45-')[1]).toBe('123-45-');
  });

  it('holds a dotted partial (F5 — separator class parity)', () => {
    const [emit, hold] = splitTrailingPartialSsn('pre 123.45');
    expect(hold).toBe('123.45');
    expect(emit).toBe('pre ');
  });

  it('reassembles an SSN split INSIDE the first group (1|23-45-6789)', () => {
    const [, hold] = splitTrailingPartialSsn('acct 1');
    expect(redactSecrets(hold + '23-45-6789 x')).toBe(`${SSN_PLACEHOLDER} x`);
  });

  it('reassembles a DOTTED SSN split across chunks (123.45|.6789)', () => {
    const [emit, hold] = splitTrailingPartialSsn('pre 123.45');
    expect(redactSecrets(emit) + redactSecrets(hold + '.6789 post')).toBe(`pre ${SSN_PLACEHOLDER} post`);
  });

  it('does NOT hold a COMPLETE SSN at the end (caught in-chunk instead)', () => {
    const [emit, hold] = splitTrailingPartialSsn('here it is 123-45-6789');
    expect(hold).toBe('');
    expect(emit).toBe('here it is 123-45-6789');
  });

  it('does NOT hold ordinary trailing text', () => {
    const [emit, hold] = splitTrailingPartialSsn('all done.');
    expect(hold).toBe('');
    expect(emit).toBe('all done.');
  });

  it('reassembles a formatted SSN split across two chunks', () => {
    const chunkA = 'tenant 123-45';
    const chunkB = '-6789 end';
    const [emitA, holdA] = splitTrailingPartialSsn(chunkA);
    expect(emitA).toBe('tenant ');
    expect(holdA).toBe('123-45');
    // The committed (safe) prefix carries no SSN; the held partial prepended
    // to the next chunk reassembles into the full SSN and gets redacted. The
    // full disk log is the concatenation of both redacted segments.
    expect(redactSecrets(emitA)).not.toContain(SSN_PLACEHOLDER);
    const fullLog = redactSecrets(emitA) + redactSecrets(holdA + chunkB);
    expect(fullLog).toBe(`tenant ${SSN_PLACEHOLDER} end`);
  });
});

describe('isPartialSsnMaterial', () => {
  it('true when the tail carries a digit group + separator', () => {
    expect(isPartialSsnMaterial('123-45-67')).toBe(true);
    expect(isPartialSsnMaterial('123 45')).toBe(true);
  });
  it('false for a bare digit run', () => {
    expect(isPartialSsnMaterial('123')).toBe(false);
  });
});

describe('redactSecrets — inbound round-trip (Layer 1)', () => {
  it('scrubs an af-style JSON payload SSN and keeps text intact', () => {
    const af = '{"unit":"4B","tenant_ssn":"123-45-6789","rent":1850}';
    expect(redactSecrets(af)).toBe(`{"unit":"4B","tenant_ssn":"${SSN_PLACEHOLDER}","rent":1850}`);
  });

  it('scrubs a pm-style context-keyed SSN', () => {
    const pm = 'Resident record — SSN: 987654321 — verified';
    expect(redactSecrets(pm)).toBe(`Resident record — SSN: ${SSN_PLACEHOLDER} — verified`);
  });

  it('redacts JWT AND SSN in the same chunk (no regression)', () => {
    const out = redactSecrets(`token=${FAKE_JWT} ssn=123-45-6789`);
    expect(out).toContain('[REDACTED_JWT]');
    expect(out).toContain(SSN_PLACEHOLDER);
    expect(out).not.toContain(FAKE_JWT);
    expect(out).not.toContain('123-45-6789');
  });

  it('does not touch a phone number in PTY output', () => {
    expect(redactSecrets('Call 423-555-0100')).toBe('Call 423-555-0100');
  });
});

describe('outbound surfaces (Layer 2) — string + meta object', () => {
  it('scrubs a bus-message string', () => {
    expect(redactSSN('forwarding tenant SSN 123-45-6789 to vendor')).toBe(
      `forwarding tenant SSN ${SSN_PLACEHOLDER} to vendor`,
    );
  });

  it('scrubs SSN inside a stringified event-meta value', () => {
    const meta = { tenant: 'A. Smith', note: 'ssn 987654321 on file' };
    const scrubbed = JSON.parse(redactSSN(JSON.stringify(meta)));
    expect(scrubbed.note).toBe(`ssn ${SSN_PLACEHOLDER} on file`);
    expect(scrubbed.tenant).toBe('A. Smith');
  });
});

// Non-circular drift-guard: the shared fixtures are the single source of truth.
// The JS side re-derives the LIVE Node Unicode tables and asserts they equal the
// fixture (ties the canonical set to live Node); mmrag.py's tests assert its
// hardcoded sets equal the SAME fixtures. So live-Node == fixture == python,
// transitively — and a drift on EITHER side, or a Node-Unicode bump, fails here
// or there (never silently). The JS INVIS uses the live \p{} class directly (it
// cannot drift from live); LABEL_SEP is an explicit hardcoded class pinned here.
import invisFixture from '../../fixtures/invis-ranges.json';
import labelSepFixture from '../../fixtures/label-sep-ranges.json';

function deriveRanges(test: (cp: number) => boolean): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  let start = -1;
  for (let cp = 0; cp <= 0x10ffff; cp++) {
    if (test(cp) && start < 0) start = cp;
    else if (!test(cp) && start >= 0) { out.push([start, cp - 1]); start = -1; }
  }
  if (start >= 0) out.push([start, 0x10ffff]);
  return out;
}

describe('cross-runtime set parity (shared fixtures)', () => {
  it('INVIS fixture == live Node \\p{Cf}\\p{Default_Ignorable}', () => {
    const live = deriveRanges((cp) => /[\p{Cf}\p{Default_Ignorable_Code_Point}]/u.test(String.fromCodePoint(cp)));
    expect(live).toEqual((invisFixture as { ranges: number[][] }).ranges);
  });

  it('LABEL_SEP class is built exactly from the label-sep fixture', () => {
    const ranges = (labelSepFixture as { ranges: number[][] }).ranges;
    const u = (cp: number) => `\\u${cp.toString(16).padStart(4, '0')}`;
    const expected = '[' + ranges.map(([a, b]) => (a === b ? u(a) : `${u(a)}-${u(b)}`)).join('') + ']';
    expect(LABEL_SEP).toBe(expected);
  });

  it('label-sep fixture is a SUPERSET of live JS \\s (no regression)', () => {
    const inFixture = (cp: number) =>
      (labelSepFixture as { ranges: number[][] }).ranges.some(([a, b]) => cp >= a && cp <= b);
    for (let cp = 0; cp <= 0x10ffff; cp++) {
      if (/\s/.test(String.fromCodePoint(cp))) expect(inFixture(cp)).toBe(true);
    }
  });
});

// MARKUP-aware egress redactor (the "B" HIGH fix). It runs on RENDERED HTML at
// the Telegram sink (after markdownToHtml) where a markdown marker interleaved
// in an SSN renders invisible and reassembles the digits — `123-45-*6789*`
// passes the raw matcher then renders `123-45-6789`. The security property is:
// after this runs, no SSN digit-sequence survives once tags/invisibles are
// stripped from the rendered output. The non-regression property is: legit
// markup and non-SSN numbers (8-digit accounts, phones) are untouched.
describe('redactSSNMarkupAware — rendered-HTML egress (B HIGH fix)', () => {
  // Strip tags + format-control chars the way a renderer would, then assert no
  // 9-run / formatted-SSN digit pattern is visible. This is the real leak test:
  // tag fragments left behind are harmless, a reassembled number is not.
  const visibleHasSsn = (html: string): boolean => {
    const rendered = html
      .replace(/<[^>]*>/g, '')
      .replace(/[\p{Cf}\p{Default_Ignorable_Code_Point}]/gu, '');
    return /\d{3}[-.\s]\d{2}[-.\s]\d{4}/.test(rendered) || /\b\d{9}\b/.test(rendered);
  };

  it('redacts a formatted SSN with a tag inside the last group', () => {
    const out = redactSSNMarkupAware('123-45-<b>6789</b>');
    expect(out).toContain(SSN_PLACEHOLDER);
    expect(visibleHasSsn(out)).toBe(false);
  });

  it('redacts a formatted SSN with tags wrapping individual digits', () => {
    const out = redactSSNMarkupAware('<b>1</b>2<b>3</b>-45-6789');
    expect(out).toContain(SSN_PLACEHOLDER);
    expect(visibleHasSsn(out)).toBe(false);
  });

  it('redacts a formatted SSN with a code tag preceding it (reviewer repro)', () => {
    const out = redactSSNMarkupAware('ssn <code>123</code>-45-6789');
    expect(out).toContain(SSN_PLACEHOLDER);
    expect(visibleHasSsn(out)).toBe(false);
  });

  it('redacts a labeled bare-9 SSN with markup between digit groups', () => {
    const out = redactSSNMarkupAware('SSN: 987<b>654</b>321');
    expect(out).toContain(SSN_PLACEHOLDER);
    expect(visibleHasSsn(out)).toBe(false);
  });

  it('keeps an UNLABELED bare-9 with markup (conservative — no false positive)', () => {
    const input = '987<b>654</b>321';
    expect(redactSSNMarkupAware(input)).toBe(input);
  });

  it('aggressive mode redacts an unlabeled bare-9 with markup', () => {
    const out = redactSSNMarkupAware('987<b>654</b>321', { aggressive: true });
    expect(out).toContain(SSN_PLACEHOLDER);
    expect(visibleHasSsn(out)).toBe(false);
  });

  it('does NOT over-redact legit bold text', () => {
    const input = '<b>important</b> update for you';
    expect(redactSSNMarkupAware(input)).toBe(input);
  });

  it('does NOT over-redact an 8-digit account number with markup', () => {
    const input = 'account <b>1234</b>5678 balance';
    expect(redactSSNMarkupAware(input)).toBe(input);
  });

  it('does NOT match a 3-3-4 phone number (wrong group shape)', () => {
    const input = '<b>123</b>-456-7890';
    expect(redactSSNMarkupAware(input)).toBe(input);
  });

  it('redacts a plain formatted SSN with no markup (superset of raw matcher)', () => {
    expect(redactSSNMarkupAware('123-45-6789')).toBe(SSN_PLACEHOLDER);
  });

  it('passes empty/falsy input through unchanged', () => {
    expect(redactSSNMarkupAware('')).toBe('');
  });

  it('is idempotent — markupAware(markupAware(x)) === markupAware(x)', () => {
    for (const input of [
      '123-45-<b>6789</b>',
      'SSN: 987<b>654</b>321',
      '<b>important</b> update',
    ]) {
      const once = redactSSNMarkupAware(input);
      expect(redactSSNMarkupAware(once)).toBe(once);
    }
  });
});
