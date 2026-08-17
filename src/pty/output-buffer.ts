import { appendFileSync, renameSync, statSync } from 'fs';
import { redactSecrets, splitTrailingPartialJwt, BARE_PREFIX_FRAGMENT } from './redact.js';
import {
  splitTrailingPartialSsn,
  splitTrailingPartialSsnLabel,
  splitTrailingPartialSsnLabelPrefix,
  isPartialSsnMaterial,
  splitTrailingPartialEin,
  splitTrailingPartialNewEntryLabel,
  splitTrailingPartialNewEntryLabelPrefix,
  isPartialNewEntryMaterial,
} from '../utils/ssn-redaction.js';

// Dynamic import for strip-ansi (ESM module)
let stripAnsi: (text: string) => string;
async function loadStripAnsi() {
  if (!stripAnsi) {
    const mod = await import('strip-ansi');
    stripAnsi = mod.default;
  }
  return stripAnsi;
}

const MAX_LOG_BYTES = 50 * 1024 * 1024; // 50 MB — rotate before OS file-cache pressure builds

/**
 * Ring buffer for PTY output. Replaces tmux capture-pane.
 * Stores raw output chunks and provides search/retrieval with ANSI stripping.
 */
export class OutputBuffer {
  private chunks: string[] = [];
  private chunkGenerations: number[] = [];
  private maxChunks: number;
  private logPath: string | null;
  private bootstrapPattern: string;
  // Readiness is monotonic within one PTY lifecycle. Prompt-like text can
  // remain in or arrive through ordinary output after the real ready marker;
  // it must never revoke readiness and re-enable bootstrap keystrokes.
  private bootstrapped: boolean = false;
  // Trailing substring of the previous push that could be the prefix of a
  // JWT *or a formatted SSN* split across the OS chunk boundary. Prepended
  // to the next chunk so redactSecrets sees the reassembled token. Bounded
  // by MAX_PARTIAL_HOLDBACK (JWT) / MAX_PARTIAL_SSN_HOLDBACK (SSN). Included
  // (safely masked — see getRecent) in getRecent() so bootstrap / rate-limit /
  // activity detection never miss live output.
  private pendingTail: string = '';
  private pendingGeneration = 0;
  private generation = 0;

  constructor(maxChunks: number = 1000, logPath?: string, bootstrapPattern?: string) {
    this.maxChunks = maxChunks;
    this.logPath = logPath || null;
    this.bootstrapPattern = bootstrapPattern || 'permissions';
  }

  /**
   * Push new output data into the buffer.
   * Also streams to log file if configured.
   *
   * Secret redaction runs once at the top via `redactSecrets` and the
   * scrubbed string is used for BOTH the in-memory ring buffer AND the
   * disk log. Without this, any JWT or session cookie an agent's shell
   * happens to print (e.g. curl -v against an authenticated endpoint)
   * would end up persisted to stdout.log verbatim. See src/pty/redact.ts
   * for the rationale.
   *
   * Chunk-boundary handling: a trailing substring that looks like the
   * start of a JWT OR a formatted SSN is held back (pendingTail) and
   * prepended to the next chunk, so a token split across two push() calls
   * is reassembled and redacted before it reaches the disk log. When both
   * a partial-JWT and a partial-SSN tail are present, the LONGER (earlier
   * starting) one is held so neither secret class can escape. Held-tail
   * contract: a tail is held only until the next push() proves it secret-
   * or-not, OR until close() flushes it at PTY exit — it is never silently
   * dropped. See close() for the exit-time disposition.
   *
   * Order matters (cross-token): redactSecrets() runs FIRST, collapsing any
   * COMPLETE token (JWT or SSN) in this chunk to a placeholder. Only then is
   * the partial-holdback computed — on the redacted string. If the holdback
   * ran first, the SSN suffix-hold could strip the trailing digits of a
   * COMPLETE JWT (whose own holdback correctly declines to split it), leaving
   * an unmatched JWT prefix in `emit` and flushing the held digits later =
   * the raw token reconstructed across the boundary. Redacting first means the
   * holdback only ever sees genuinely-incomplete partials.
   */
  push(data: string): void {
    const generation = ++this.generation;
    const redacted = redactSecrets(this.pendingTail + data);
    const [, holdJwt] = splitTrailingPartialJwt(redacted);
    const [, holdSsn] = splitTrailingPartialSsn(redacted);
    // Also retain a trailing SSN-LABEL region (e.g. a chunk ending `SSN: ` or
    // `social security number `): the next chunk's number reassembles WITH its
    // label so the context-keyed redaction fires, closing the chunk-split
    // `SSN: ` | `987654321` leak to stdout.log (a Layer-1-only sink).
    const [, holdLabel] = splitTrailingPartialSsnLabel(redacted);
    // Also retain a trailing PARTIAL label TOKEN split mid-token across the
    // boundary (e.g. a chunk ending `SS`, the `N: 987654321` arriving next):
    // splitTrailingPartialSsnLabel needs a COMPLETE label, so the mid-token
    // split would otherwise reach stdout.log raw. Held bytes are re-emitted on
    // the next chunk, so a non-label tail is delayed one chunk, never lost.
    const [, holdLabelPrefix] = splitTrailingPartialSsnLabelPrefix(redacted);
    // PII v2 m2 — the same holdback discipline for the new registry entries (EIN,
    // routing, bank-account). A labeled new-entry value split across the boundary
    // (`routing ` | `021000021`, `bank account ` | `123456789012`, `EIN 12-345` |
    // `6789`) would otherwise commit the label/prefix chunk (nothing to redact
    // yet) and let the value chunk land RAW in stdout.log. These hold:
    //   - a trailing partial FORMATTED EIN (`12-345`);
    //   - a trailing COMPLETE new-entry label (`routing `, `bank account `);
    //   - a trailing PARTIAL label token split mid-token (`routi`, `bank acc`).
    const [, holdEin] = splitTrailingPartialEin(redacted);
    const [, holdNewLabel] = splitTrailingPartialNewEntryLabel(redacted);
    const [, holdNewLabelPrefix] = splitTrailingPartialNewEntryLabelPrefix(redacted);
    // Hold whichever candidate covers MORE trailing characters — all are
    // suffixes of `redacted`, so the longest suffix subsumes the others and
    // protects every secret class at once.
    const hold = [
      holdJwt,
      holdSsn,
      holdLabel,
      holdLabelPrefix,
      holdEin,
      holdNewLabel,
      holdNewLabelPrefix,
    ].reduce((a, b) => (b.length > a.length ? b : a), '');
    const emit = hold ? redacted.slice(0, redacted.length - hold.length) : redacted;
    this.pendingTail = hold;
    this.pendingGeneration = hold ? generation : 0;
    if (!emit) return; // everything held back as a potential partial token

    this.commit(emit, generation); // already redacted above
  }

  /**
   * Append already-redacted data to the in-memory ring buffer and stream
   * it to the disk log. Shared by push() and close().
   */
  private commit(safe: string, generation: number): void {
    this.chunks.push(safe);
    this.chunkGenerations.push(generation);
    if (this.chunks.length > this.maxChunks) {
      this.chunks.shift();
      this.chunkGenerations.shift();
    }

    // Stream to log file (replaces tmux pipe-pane)
    if (this.logPath) {
      try {
        try {
          const size = statSync(this.logPath).size;
          if (size >= MAX_LOG_BYTES) {
            try { renameSync(this.logPath, this.logPath + '.1'); } catch { /* ignore */ }
          }
        } catch { /* file doesn't exist yet — skip rotation check */ }
        appendFileSync(this.logPath, safe, 'utf-8');
      } catch {
        // Ignore log write errors
      }
    }
  }

  /**
   * Flush the held-back tail at end-of-stream (PTY exit/teardown).
   *
   * If the PTY dies while a potential partial-JWT tail is held, those
   * bytes would otherwise vanish silently — not lossless for false
   * positives (legitimate base64 JSON that merely starts with `eyJ`, or
   * ordinary output ending in `e`/`ey`). Disposition:
   *
   * - Bare prefix fragment (`e`, `ey`, `eyJ`): emitted VERBATIM — it
   *   contains no token header/payload/signature bytes, and replacing a
   *   legit trailing `e` with a marker would mangle ordinary output.
   * - Partial-SSN material (a digit group + separator, e.g. `123-45-67`):
   *   masked with `[REDACTED_POSSIBLE_SSN_TAIL]` — the held bytes carry
   *   most of an SSN, so they must not reach the log.
   * - Partial formatted-EIN material (a 2-digit group + separator + a digit,
   *   e.g. `12-3`, held as a possible EIN prefix split across the boundary):
   *   masked with `[REDACTED_POSSIBLE_EIN_TAIL]` — the held bytes carry most
   *   of a formatted EIN, so they must not reach the log.
   * - A bare short digit run with no separator (e.g. `123`, held as a
   *   possible SSN/EIN prefix), or a partial-EIN prefix with no second-group
   *   digit yet (e.g. `12-`): emitted VERBATIM — it carries no secret
   *   structure and masking it would mangle ordinary numeric output.
   * - Anything else longer: may contain real JWT header/payload bytes that
   *   redactSecrets cannot match (the token is incomplete), so the log
   *   gets an explicit `[REDACTED_POSSIBLE_JWT_TAIL]` marker instead —
   *   loss is recorded, secrets are not.
   *
   * Idempotent: the tail is cleared first, so a second close() (e.g.
   * kill() followed by the onExit event) writes nothing.
   */
  close(): void {
    const tail = this.pendingTail;
    const generation = this.pendingGeneration;
    this.pendingTail = '';
    this.pendingGeneration = 0;
    if (!tail) return;
    if (BARE_PREFIX_FRAGMENT.test(tail)) {
      this.commit(tail, generation);
    } else if (isPartialSsnMaterial(tail)) {
      this.commit('[REDACTED_POSSIBLE_SSN_TAIL]', generation);
    } else if (isPartialNewEntryMaterial(tail)) {
      // A partial formatted-EIN tail (`12-3`…`12-345678`) held across the
      // boundary — carries most of an EIN, mask rather than leak it.
      this.commit('[REDACTED_POSSIBLE_EIN_TAIL]', generation);
    } else if (/^\d{1,2}[-.\t ]?\s*$/.test(tail)) {
      // A bare 1-2 digit run, optionally with a single trailing separator and
      // whitespace (e.g. `123`-style SSN prefix is covered below; here `12`,
      // `12-`, `12 ` held only as a possible SSN/EIN prefix) — no maskable
      // secret material (no second-group digit), emit verbatim.
      this.commit(tail, generation);
    } else if (/^\d{1,3}\s*$/.test(tail)) {
      // Bare digit run (optionally newline/space-terminated, e.g. `exit 123\n`)
      // held only as a possible SSN prefix — no secret material, emit verbatim.
      // The trailing-whitespace tolerance matters because the holdback treats
      // `\s` as a separator, so an ordinary "<short number>\n" line gets held.
      this.commit(tail, generation);
    } else if (!/\d/.test(tail)) {
      // A held trailing SSN-label region with NO digits yet (e.g. `SSN: ` held
      // because the stream ended before its number arrived) — a label carries
      // no secret on its own, emit verbatim rather than mask it.
      this.commit(tail, generation);
    } else {
      this.commit('[REDACTED_POSSIBLE_JWT_TAIL]', generation);
    }
  }

  private getSafePendingTail(): string {
    return isPartialSsnMaterial(this.pendingTail)
      ? '[REDACTED_POSSIBLE_SSN_TAIL]'
      : isPartialNewEntryMaterial(this.pendingTail)
        ? '[REDACTED_POSSIBLE_EIN_TAIL]'
        : redactSecrets(this.pendingTail);
  }

  /**
   * Get the last N chunks of output joined together.
   */
  getRecent(n?: number): string {
    const count = n || this.chunks.length;
    // Append the held-back tail (safely) so consumers that poll recent output
    // — bootstrap detection, trust-prompt detection, rate-limit scans — see
    // the latest bytes even while a potential partial token is withheld from
    // the disk log. redactSecrets() only redacts COMPLETE JWT/SSN tokens; a
    // held INCOMPLETE partial SSN (e.g. `123-45-6`) is not a complete token,
    // so it must be masked here exactly as close() does — otherwise a poller
    // (e.g. the fast-checker) would see most of an SSN.
    return this.chunks.slice(-count).join('') + this.getSafePendingTail();
  }

  /**
   * Get a bounded tail of recent output for prompt detection.
   */
  getRecentTail(maxBytes = 4096): string {
    return this.getRecent().slice(-maxBytes);
  }

  /** Mark the current push generation without copying output into another buffer. */
  createSafeCursor(): number {
    return this.generation;
  }

  /**
   * Return only output received after a cursor, using the same redacted chunks
   * as every other OutputBuffer consumer. Pending holdback is deliberately
   * excluded until a later push proves and commits it safely; exposing a
   * partial token here would make prompt detection a secret side channel.
   */
  getSafeTailSince(cursor: number, maxBytes = 4096): string {
    const committed = this.chunks
      .filter((_chunk, index) => this.chunkGenerations[index] > cursor)
      .join('');
    return committed.slice(-maxBytes);
  }

  /**
   * Search for a pattern in recent output (ANSI codes stripped).
   * Used for bootstrap detection ("permissions" text).
   */
  async search(pattern: string): Promise<boolean> {
    const strip = await loadStripAnsi();
    const text = strip(this.getRecent());
    return text.includes(pattern);
  }

  /**
   * Synchronous search for simple patterns.
   * Does basic ANSI stripping inline (strips ESC[ sequences).
   */
  searchSync(pattern: string): boolean {
    const text = this.getRecent().replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '');
    return text.includes(pattern);
  }

  /**
   * Check if agent has bootstrapped (ready-for-input signal appeared).
   *
   * For Claude Code: looks for the "permissions" status-bar text.
   * For Hermes: looks for the "❯" prompt character (configurable via constructor).
   * The bootstrap pattern is set at construction time by the PTY class.
   */
  isBootstrapped(): boolean {
    if (this.bootstrapped) return true;

    const recent = this.getRecent();
    const cleaned = recent.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '');

    if (this.bootstrapPattern === 'permissions') {
      // Claude Code: a first-run dialog can itself contain the readiness word,
      // and old dialog text remains in the ring after the real status bar is
      // rendered. Treat the latest relevant marker as authoritative: a status
      // bar must appear after every blocking-dialog marker.
      const lower = cleaned.toLowerCase();
      const readyAt = cleaned.lastIndexOf(this.bootstrapPattern);
      const continueWithoutAt = lower.lastIndexOf('continue without these permissions');
      const continuePermissionsAt = continueWithoutAt >= 0
        ? continueWithoutAt + 'continue without these '.length
        : -1;
      const blockedAt = Math.max(
        lower.lastIndexOf('trust'),
        lower.lastIndexOf('no, exit'),
        continuePermissionsAt,
        lower.lastIndexOf('bypass permissions'),
      );
      this.bootstrapped = readyAt >= 0 && readyAt > blockedAt;
      return this.bootstrapped;
    }

    this.bootstrapped = cleaned.includes(this.bootstrapPattern);
    return this.bootstrapped;
  }

  /**
   * Get the total size of buffered output in bytes.
   * Useful for activity detection (typing indicator).
   */
  getSize(): number {
    let size = 0;
    for (const chunk of this.chunks) {
      size += chunk.length;
    }
    // Include the held-back tail so size-based activity detection still
    // registers output that is pending the chunk-boundary redaction check.
    return size + this.pendingTail.length;
  }

  /**
   * Check whether the recent PTY output contains signatures of an Anthropic
   * API rate-limit or overload response. Used by the daemon to distinguish
   * rate-limit exits from real crashes so it can apply an extended pause
   * instead of the normal crash-backoff cycle.
   *
   * Patterns matched (case-insensitive, ANSI stripped):
   *   - "overloaded_error" / "overloaded" (HTTP 529 body)
   *   - "rate_limit_error" / "rate limit" / "rate-limit"
   *   - "too many requests"
   *   - "quota exceeded" / "usage limit"
   *   - "529"
   */
  hasRateLimitSignature(): boolean {
    // Only scan the last 200 chunks — rate-limit messages appear near session end
    const text = this.chunks.slice(-200).join('').replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '').toLowerCase();
    return (
      text.includes('overloaded_error') ||
      text.includes('rate_limit_error') ||
      text.includes('rate limit') ||
      text.includes('rate-limit') ||
      text.includes('too many requests') ||
      text.includes('quota exceeded') ||
      text.includes('usage limit') ||
      // HTTP 529 status line or JSON error code
      (text.includes('529') && (text.includes('overload') || text.includes('error')))
    );
  }

  /**
   * Clear the buffer.
   */
  clear(): void {
    this.chunks = [];
    this.chunkGenerations = [];
    this.pendingTail = '';
    this.pendingGeneration = 0;
    this.bootstrapped = false;
  }
}
