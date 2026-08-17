import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// Mock fs.appendFileSync so tests don't actually write to disk. We still
// need the real existsSync etc. for other imports in the module graph.
const appendFileSyncMock = vi.fn();
vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs');
  return {
    ...actual,
    appendFileSync: (...args: unknown[]) => appendFileSyncMock(...args),
  };
});

const { OutputBuffer } = await import('../../../src/pty/output-buffer');

// Synthetic JWT used across tests. Has the canonical 3-segment shape and
// the `eyJ` header prefix so the redactor matches it. Length exceeds the
// {10,} per-segment minimum.
const FAKE_JWT =
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJ0ZXN0LXNlc3Npb24taWQifQ.abcdefghij_-abcdefghij';

beforeEach(() => {
  appendFileSyncMock.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('OutputBuffer redaction', () => {
  it('single JWT in a single chunk: redacted in both disk log and in-memory buffer', () => {
    const buf = new OutputBuffer(1000, '/tmp/fake-stdout.log');
    buf.push(`session cookie: authjs.session-token=${FAKE_JWT}\n`);

    expect(appendFileSyncMock).toHaveBeenCalledTimes(1);
    const writtenData = String(appendFileSyncMock.mock.calls[0][1]);
    expect(writtenData).toContain('[REDACTED_JWT]');
    expect(writtenData).not.toContain(FAKE_JWT);

    // In-memory ring buffer should also see the redacted form.
    const recent = buf.getRecent();
    expect(recent).toContain('[REDACTED_JWT]');
    expect(recent).not.toContain(FAKE_JWT);
  });

  it('multiple JWTs in one chunk: all redacted', () => {
    const buf = new OutputBuffer(1000, '/tmp/fake-stdout.log');
    const another =
      'eyJxxxxxxxxxxxxxx.yyyyyyyyyyyyyyyy.zzzzzzzzzzzzzzzz__';
    buf.push(`a=${FAKE_JWT} b=${another} c=${FAKE_JWT}`);

    const written = String(appendFileSyncMock.mock.calls[0][1]);
    // Every JWT-shaped token replaced with the literal redaction marker.
    expect(written).not.toContain(FAKE_JWT);
    expect(written).not.toContain(another);
    const matches = (written.match(/\[REDACTED_JWT\]/g) || []).length;
    expect(matches).toBe(3);
  });

  it('non-JWT PTY data passes through unchanged (regression guard)', () => {
    const buf = new OutputBuffer(1000, '/tmp/fake-stdout.log');
    // TUI ANSI escapes, regular stdout, plausible-but-too-short alphanum.
    const tuiOutput =
      '\x1b[38;5;114m●\x1b[39m Running tests... version v1.2.3 hash=abc.def.ghi\n';
    buf.push(tuiOutput);

    const written = String(appendFileSyncMock.mock.calls[0][1]);
    expect(written).toBe(tuiOutput); // byte-for-byte identical
    expect(written).not.toContain('[REDACTED_JWT]');
  });

  it('bootstrap detection still works after redaction', () => {
    const buf = new OutputBuffer(1000, '/tmp/fake-stdout.log');
    // Claude Code's permissions status bar line — contains "permissions"
    // which isBootstrapped() searches for. No JWT in this chunk — the
    // test guards that redaction does not accidentally break the ring
    // buffer's search path.
    buf.push('\x1b[2m ? \x1b[0mfor shortcuts                  permissions: bypass\n');
    expect(buf.isBootstrapped()).toBe(true);
  });

  it('latches bootstrap readiness until the buffer lifecycle is cleared', () => {
    const buf = new OutputBuffer(1000, undefined, 'permissions');

    buf.push('accept edits · permissions\n');
    expect(buf.isBootstrapped()).toBe(true);

    // Prompt-like ordinary output after readiness must not re-arm bootstrap
    // automation by making the latest blocking token newer than readiness.
    buf.push('documentation: trust this folder, then choose Yes\n');
    expect(buf.isBootstrapped()).toBe(true);

    buf.clear();
    expect(buf.isBootstrapped()).toBe(false);
  });

  it('JWT split across a chunk boundary IS redacted (buffer-aware holdback)', () => {
    // Split a JWT across two push() calls — the OS chunk-boundary case
    // that the stateless chunk-local redactor used to miss. push() now
    // holds back the trailing partial-JWT prefix and prepends it to the
    // next chunk, so the reassembled token is redacted before anything
    // reaches the disk log.
    const buf = new OutputBuffer(1000, '/tmp/fake-stdout.log');
    const half1 = FAKE_JWT.slice(0, 40);
    const half2 = FAKE_JWT.slice(40);
    buf.push(`prefix ${half1}`);
    buf.push(`${half2} suffix\n`);

    // First write: only the non-token prefix reaches the log — the
    // partial JWT is held back.
    const firstWrite = String(appendFileSyncMock.mock.calls[0][1]);
    expect(firstWrite).toBe('prefix ');
    expect(firstWrite).not.toContain('eyJ');

    // Second write: held tail + second half reassembled and redacted.
    const secondWrite = String(appendFileSyncMock.mock.calls[1][1]);
    expect(secondWrite).toContain('[REDACTED_JWT]');
    expect(secondWrite).toContain(' suffix');
    expect(secondWrite).not.toContain(FAKE_JWT);

    // The full token never appears anywhere — log or in-memory buffer.
    const allWrites = appendFileSyncMock.mock.calls.map(c => String(c[1])).join('');
    expect(allWrites).not.toContain(FAKE_JWT);
    expect(buf.getRecent()).not.toContain(FAKE_JWT);
    expect(buf.getRecent()).toContain('[REDACTED_JWT]');
  });

  it('JWT split across THREE chunks is still redacted', () => {
    const buf = new OutputBuffer(1000, '/tmp/fake-stdout.log');
    buf.push(`token=${FAKE_JWT.slice(0, 20)}`);
    buf.push(FAKE_JWT.slice(20, 60));
    buf.push(`${FAKE_JWT.slice(60)}\n`);

    const allWrites = appendFileSyncMock.mock.calls.map(c => String(c[1])).join('');
    expect(allWrites).not.toContain(FAKE_JWT);
    expect(allWrites).toContain('[REDACTED_JWT]');
  });

  it('held-back tail is still visible (redacted) via getRecent for bootstrap/activity detection', () => {
    const buf = new OutputBuffer(1000, '/tmp/fake-stdout.log');
    const partial = FAKE_JWT.slice(0, 40);
    buf.push(`output ends with a partial token ${partial}`);

    // The partial tail must not silently vanish from the in-memory view —
    // pollers (bootstrap, rate-limit, typing-indicator size checks) read
    // getRecent()/getSize() and need to see the latest bytes.
    expect(buf.getRecent()).toContain('output ends with a partial token');
    expect(buf.getRecent()).toContain(partial);
    expect(buf.getSize()).toBe(`output ends with a partial token ${partial}`.length);
  });

  it('safe cursor returns only newly committed redacted output', () => {
    const buf = new OutputBuffer(1000, '/tmp/fake-stdout.log');
    buf.push('old prompt\n');
    const cursor = buf.createSafeCursor();

    buf.push(`token=${FAKE_JWT}\n`);
    const fresh = buf.getSafeTailSince(cursor);

    expect(fresh).toBe('token=[REDACTED_JWT]\n');
    expect(fresh).not.toContain('old prompt');
    expect(fresh).not.toContain(FAKE_JWT);
  });

  it('safe cursor never exposes a JWT split across push boundaries', () => {
    const buf = new OutputBuffer(1000, '/tmp/fake-stdout.log');
    const cursor = buf.createSafeCursor();

    buf.push(`token=${FAKE_JWT.slice(0, 40)}`);
    expect(buf.getSafeTailSince(cursor)).not.toContain(FAKE_JWT.slice(0, 40));

    buf.push(`${FAKE_JWT.slice(40)}\n`);
    const fresh = buf.getSafeTailSince(cursor);
    expect(fresh).toBe('token=[REDACTED_JWT]\n');
    expect(fresh).not.toContain(FAKE_JWT);
  });

  it('partial-token holdback flushes unredacted when it turns out NOT to be a JWT', () => {
    const buf = new OutputBuffer(1000, '/tmp/fake-stdout.log');
    // Looks like a JWT prefix at the boundary, but the next chunk reveals
    // it was ordinary text — everything must flush through unredacted and
    // in the original byte order.
    buf.push('checking eyJsomething');
    buf.push(' else entirely\n');

    const allWrites = appendFileSyncMock.mock.calls.map(c => String(c[1])).join('');
    expect(allWrites).toBe('checking eyJsomething else entirely\n');
    expect(allWrites).not.toContain('[REDACTED_JWT]');
  });

  it('oversized trailing base64 blob is emitted, not held back (MAX_PARTIAL_HOLDBACK cap)', () => {
    const buf = new OutputBuffer(1000, '/tmp/fake-stdout.log');
    // A legitimate base64-encoded JSON blob (starts with eyJ, no dots)
    // larger than the holdback cap — must NOT be withheld from the log.
    const bigBlob = 'eyJ' + 'A'.repeat(4000);
    buf.push(`payload=${bigBlob}`);

    expect(appendFileSyncMock).toHaveBeenCalledTimes(1);
    const written = String(appendFileSyncMock.mock.calls[0][1]);
    expect(written).toContain(bigBlob);
  });

  it('trailing COMPLETE JWT is redacted and emitted immediately (no indefinite holdback)', () => {
    const buf = new OutputBuffer(1000, '/tmp/fake-stdout.log');
    // Chunk ends exactly at the end of a complete JWT (e.g. last output
    // before the process exits). It must reach the log redacted rather
    // than being withheld forever waiting for a next chunk.
    buf.push(`cookie=${FAKE_JWT}`);

    expect(appendFileSyncMock).toHaveBeenCalledTimes(1);
    const written = String(appendFileSyncMock.mock.calls[0][1]);
    expect(written).toBe('cookie=[REDACTED_JWT]');
  });

  it('clear() resets the held-back tail', () => {
    const buf = new OutputBuffer(1000, '/tmp/fake-stdout.log');
    buf.push(`partial ${FAKE_JWT.slice(0, 40)}`);
    buf.clear();
    expect(buf.getRecent()).toBe('');
    expect(buf.getSize()).toBe(0);
  });

  it('short alphanumeric that resembles a truncated JWT is NOT redacted (length guard)', () => {
    const buf = new OutputBuffer(1000, '/tmp/fake-stdout.log');
    // "eyJab.x.y" has the right header prefix and the right shape but
    // segments are all too short — the {10,} length qualifier must
    // prevent this from matching.
    const shortTokenLike = 'eyJab.x.y';
    buf.push(`debug_token=${shortTokenLike} ok=true\n`);

    const written = String(appendFileSyncMock.mock.calls[0][1]);
    expect(written).toContain(shortTokenLike);
    expect(written).not.toContain('[REDACTED_JWT]');
  });
});

describe('OutputBuffer redaction — split inside the eyJ prefix (P1 regression)', () => {
  // The chunk boundary can fall INSIDE the `eyJ` header prefix. The old
  // holdback regex required the full `eyJ` to be present, so a chunk
  // ending `...e` or `...ey` was emitted to the disk log immediately;
  // chunk 2 (starting `yJ...`/`J...`) never matched JWT_PATTERN either,
  // and the concatenated log contained the full token unredacted. These
  // tests exercise every split offset Codie called out and assert the
  // disk log (allWrites) never contains the full synthetic JWT.

  const allWrites = () =>
    appendFileSyncMock.mock.calls.map(c => String(c[1])).join('');

  it.each([
    [1, 'after "e"'],
    [2, 'after "ey"'],
    [3, 'after "eyJ"'],
  ])('JWT split at offset %i (%s) is redacted in the disk log', (offset) => {
    const buf = new OutputBuffer(1000, '/tmp/fake-stdout.log');
    buf.push(`token=${FAKE_JWT.slice(0, offset)}`);
    buf.push(`${FAKE_JWT.slice(offset)}\n`);

    const written = allWrites();
    expect(written).not.toContain(FAKE_JWT);
    expect(written).toContain('[REDACTED_JWT]');
    expect(written).toBe('token=[REDACTED_JWT]\n');
    // In-memory view must agree.
    expect(buf.getRecent()).not.toContain(FAKE_JWT);
  });

  it('JWT split later in the token (5 chars into the signature) is redacted', () => {
    const buf = new OutputBuffer(1000, '/tmp/fake-stdout.log');
    // Boundary inside the third segment, before it reaches the {10,}
    // minimum — the held candidate is a genuine partial, not yet a
    // complete JWT shape, so the holdback path (not the emit-now
    // complete-shape path) is exercised.
    const offset = FAKE_JWT.lastIndexOf('.') + 1 + 5;
    buf.push(`token=${FAKE_JWT.slice(0, offset)}`);
    buf.push(`${FAKE_JWT.slice(offset)}\n`);

    const written = allWrites();
    expect(written).not.toContain(FAKE_JWT);
    expect(written).toBe('token=[REDACTED_JWT]\n');
  });

  it('prefix split combined with a later split (three chunks: "e" | mid | rest)', () => {
    const buf = new OutputBuffer(1000, '/tmp/fake-stdout.log');
    buf.push('token=e');
    buf.push(FAKE_JWT.slice(1, 50));
    buf.push(`${FAKE_JWT.slice(50)}\n`);

    const written = allWrites();
    expect(written).not.toContain(FAKE_JWT);
    expect(written).toBe('token=[REDACTED_JWT]\n');
  });

  it('ordinary text ending in "e"/"ey" flushes through losslessly on the next chunk', () => {
    const buf = new OutputBuffer(1000, '/tmp/fake-stdout.log');
    buf.push('build done'); // ends in "e" — briefly held
    buf.push(' — all tests pass\n');
    buf.push('they'); // ends in "ey" — briefly held
    buf.push(' said so\n');

    expect(allWrites()).toBe('build done — all tests pass\nthey said so\n');
    expect(allWrites()).not.toContain('[REDACTED');
  });
});

describe('OutputBuffer.close() — held-tail flush at PTY exit (P3 regression)', () => {
  const allWrites = () =>
    appendFileSyncMock.mock.calls.map(c => String(c[1])).join('');

  it('writes [REDACTED_POSSIBLE_JWT_TAIL] when the stream dies mid-hold', () => {
    const buf = new OutputBuffer(1000, '/tmp/fake-stdout.log');
    const partial = FAKE_JWT.slice(0, 40); // header + start of payload
    buf.push(`last output ${partial}`); // tail held, awaiting next chunk
    buf.close(); // PTY exits — no next chunk ever comes

    const written = allWrites();
    // Bytes are not silently dropped: loss is recorded with the marker...
    expect(written).toBe('last output [REDACTED_POSSIBLE_JWT_TAIL]');
    // ...and no fragment of the held token reaches the disk log.
    expect(written).not.toContain(partial);
    expect(written).not.toContain('eyJ');
  });

  it('flushes a bare prefix fragment ("e"/"ey"/"eyJ") verbatim — no marker, no mangling', () => {
    const buf = new OutputBuffer(1000, '/tmp/fake-stdout.log');
    buf.push('session complete'); // ends in "e" — held as a possible prefix
    buf.close();

    // A bare fragment carries no token material; replacing the final "e"
    // of ordinary output with a marker would corrupt the log.
    expect(allWrites()).toBe('session complete');
    expect(allWrites()).not.toContain('[REDACTED_POSSIBLE_JWT_TAIL]');
  });

  it('is idempotent — second close() writes nothing', () => {
    const buf = new OutputBuffer(1000, '/tmp/fake-stdout.log');
    buf.push(`tail ${FAKE_JWT.slice(0, 30)}`);
    buf.close();
    const callsAfterFirst = appendFileSyncMock.mock.calls.length;
    buf.close();
    expect(appendFileSyncMock.mock.calls.length).toBe(callsAfterFirst);
    expect((allWrites().match(/\[REDACTED_POSSIBLE_JWT_TAIL\]/g) || []).length).toBe(1);
  });

  it('no-op when nothing is held', () => {
    const buf = new OutputBuffer(1000, '/tmp/fake-stdout.log');
    buf.push('clean output\n');
    const callsBefore = appendFileSyncMock.mock.calls.length;
    buf.close();
    expect(appendFileSyncMock.mock.calls.length).toBe(callsBefore);
  });

  it('held tail appears in the in-memory ring buffer after close (marker form)', () => {
    const buf = new OutputBuffer(1000, '/tmp/fake-stdout.log');
    buf.push(`ends with ${FAKE_JWT.slice(0, 30)}`);
    buf.close();
    expect(buf.getRecent()).toContain('[REDACTED_POSSIBLE_JWT_TAIL]');
    expect(buf.getRecent()).not.toContain('eyJ');
    expect(buf.getSize()).toBe('ends with [REDACTED_POSSIBLE_JWT_TAIL]'.length);
  });
});
