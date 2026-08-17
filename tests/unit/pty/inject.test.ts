import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { MessageDedup, KEYS, injectMessage, sanitizeForInjection } from '../../../src/pty/inject';

describe('MessageDedup', () => {
  it('detects duplicate content', () => {
    const dedup = new MessageDedup();
    expect(dedup.isDuplicate('hello world')).toBe(false);
    expect(dedup.isDuplicate('hello world')).toBe(true);
  });

  it('allows different content', () => {
    const dedup = new MessageDedup();
    expect(dedup.isDuplicate('message 1')).toBe(false);
    expect(dedup.isDuplicate('message 2')).toBe(false);
  });

  it('evicts old entries', () => {
    const dedup = new MessageDedup(3);
    dedup.isDuplicate('msg1');
    dedup.isDuplicate('msg2');
    dedup.isDuplicate('msg3');
    dedup.isDuplicate('msg4'); // evicts msg1
    expect(dedup.isDuplicate('msg1')).toBe(false); // no longer in cache
    expect(dedup.isDuplicate('msg4')).toBe(true); // still in cache
  });

  it('can release a provisional identity after failed admission', () => {
    const dedup = new MessageDedup();
    expect(dedup.isDuplicate('fire-1')).toBe(false);
    dedup.remove('fire-1');
    expect(dedup.isDuplicate('fire-1')).toBe(false);
    expect(dedup.isDuplicate('fire-1')).toBe(true);
  });

  it('bounds eviction independently per provenance scope', () => {
    const dedup = new MessageDedup(2);
    expect(dedup.isDuplicate('fire-1', 'daemon-structured')).toBe(false);
    expect(dedup.isDuplicate('ordinary-1', 'ordinary-content')).toBe(false);
    expect(dedup.isDuplicate('ordinary-2', 'ordinary-content')).toBe(false);
    expect(dedup.isDuplicate('ordinary-3', 'ordinary-content')).toBe(false);

    expect(dedup.isDuplicate('fire-1', 'daemon-structured')).toBe(true);
    expect(dedup.isDuplicate('ordinary-1', 'ordinary-content')).toBe(false);
  });
});

describe('KEYS', () => {
  it('has correct escape sequences', () => {
    expect(KEYS.ENTER).toBe('\r');
    expect(KEYS.CTRL_C).toBe('\x03');
    expect(KEYS.DOWN).toBe('\x1b[B');
    expect(KEYS.UP).toBe('\x1b[A');
    expect(KEYS.SPACE).toBe(' ');
  });
});

describe('sanitizeForInjection — escape-sequence breakout protection', () => {
  it('strips a bracketed-paste END marker embedded in content', () => {
    // An attacker-controlled message containing ESC[201~ would terminate
    // bracketed paste early — everything after it would be interpreted as
    // TYPED keystrokes (TUI navigation, auto-approve Enter, etc.).
    const malicious = 'innocent text\x1b[201~\rrm -rf /\r';
    const safe = sanitizeForInjection(malicious);
    expect(safe).not.toContain('\x1b');
    // The marker degrades to harmless literal text.
    expect(safe).toContain('[201~');
  });

  it('strips other C0 control characters but preserves tab/newline/CR', () => {
    const input = 'line1\nline2\r\nta\tb\x00\x07\x08\x0b\x7fend';
    const safe = sanitizeForInjection(input);
    expect(safe).toBe('line1\nline2\r\nta\tbend');
  });

  it('strips 8-bit CSI (\\x9b) — C1-encoded paste-END breakout is neutralized', () => {
    // \x9b is the single-byte (C1) equivalent of ESC[. In terminal modes
    // that honor 8-bit controls, "\x9b201~" terminates bracketed paste
    // exactly like "\x1b[201~" — the same breakout class, alternate
    // encoding. It must be stripped, not passed through.
    const malicious = 'innocent text\x9b201~\rrm -rf /\r';
    const safe = sanitizeForInjection(malicious);
    expect(safe).not.toContain('\x9b');
    // Degrades to harmless literal text, remainder intact.
    expect(safe).toBe('innocent text201~\rrm -rf /\r');
  });

  it('strips the full C1 control block (\\x80-\\x9f) but preserves printable Latin-1 and above', () => {
    const input = 'a\x80b\x85c\x9bd\x9fé ❯ 👍';
    expect(sanitizeForInjection(input)).toBe('abcdé ❯ 👍');
  });

  it('injectMessage neutralizes an embedded \\x9b201~ before pasting', () => {
    vi.useFakeTimers();
    try {
      const writes: string[] = [];
      const write = (data: string) => { writes.push(data); };
      injectMessage(write, 'hi\x9b201~breakout', 300);
      const pasted = writes.join('');
      expect(pasted).not.toContain('\x9b');
      // Our own 7-bit paste-END remains the only terminator, at the end.
      expect(pasted.match(/\x1b\[201~/g)).toHaveLength(1);
      expect(pasted.endsWith('\x1b[201~')).toBe(true);
      expect(pasted).toContain('hi201~breakout');
    } finally {
      vi.useRealTimers();
    }
  });

  it('passes ordinary multi-line unicode content through unchanged', () => {
    const input = '=== TELEGRAM from Dave (chat_id:42) ===\nHello! ❯ ⚔ émoji 👍\nReply soon.';
    expect(sanitizeForInjection(input)).toBe(input);
  });

  it('injectMessage applies sanitization before pasting', () => {
    vi.useFakeTimers();
    try {
      const writes: string[] = [];
      const write = (data: string) => { writes.push(data); };
      injectMessage(write, 'hi\x1b[201~breakout', 300);
      const pasted = writes.join('');
      // Exactly one paste-start and one paste-end — both OURS, none from
      // the message content.
      expect(pasted.match(/\x1b\[200~/g)).toHaveLength(1);
      expect(pasted.match(/\x1b\[201~/g)).toHaveLength(1);
      expect(pasted.endsWith('\x1b[201~')).toBe(true);
      expect(pasted).toContain('hi[201~breakout');
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('injectMessage — deferred Enter crash safety', () => {
  // Regression guard for the 2026-04-22 storm. worker-process.ts:93 passed
  // an unsafe `this.pty!.write` callback; when PTY was torn down during the
  // 300ms enterDelay window the setTimeout fired null.write → uncaught
  // TypeError → daemon crash. The fix wraps the deferred write in try/catch.
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.useFakeTimers();
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.useRealTimers();
    warnSpy.mockRestore();
  });

  it('swallows throw from the deferred Enter callback without crashing', () => {
    const writes: string[] = [];
    // Caller's write is "safe" during the synchronous paste but starts
    // throwing by the time the deferred Enter fires — simulates PTY teardown.
    let ptyAlive = true;
    const write = (data: string) => {
      if (!ptyAlive) throw new TypeError("Cannot read properties of null (reading 'write')");
      writes.push(data);
    };

    // Synchronous calls (paste markers + content) should succeed.
    expect(() => injectMessage(write, 'hello', 300)).not.toThrow();
    expect(writes.length).toBeGreaterThan(0);

    // PTY dies before the 300ms Enter timeout fires.
    ptyAlive = false;

    // Advancing the clock invokes the deferred callback. Must NOT propagate.
    expect(() => vi.advanceTimersByTime(300)).not.toThrow();

    // The warn path in inject.ts confirms the catch branch ran.
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls[0][0]).toMatch(/deferred Enter failed/);
  });

  it('sends Enter normally when the PTY stays alive', () => {
    const writes: string[] = [];
    const write = (data: string) => { writes.push(data); };

    injectMessage(write, 'hi', 300);
    const writesBeforeTimer = writes.length;
    vi.advanceTimersByTime(300);

    // Exactly one new write — the ENTER keystroke — and no warn.
    expect(writes.length).toBe(writesBeforeTimer + 1);
    expect(writes[writes.length - 1]).toBe(KEYS.ENTER);
    expect(warnSpy).not.toHaveBeenCalled();
  });
});
