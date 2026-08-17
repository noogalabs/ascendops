import { createHash } from 'crypto';

// Bracketed paste mode escape sequences
const PASTE_START = '\x1b[200~';
const PASTE_END = '\x1b[201~';

// Key escape sequences for TUI navigation
export const KEYS = {
  ENTER: '\r',
  CTRL_C: '\x03',
  DOWN: '\x1b[B',
  UP: '\x1b[A',
  SPACE: ' ',
  ESCAPE: '\x1b',
  TAB: '\t',
} as const;

/**
 * Message deduplication via MD5 hash.
 * Prevents double-injection on crash recovery.
 * Matches bash fast-checker.sh dedup pattern.
 */
export class MessageDedup {
  private hashesByScope = new Map<string, string[]>();
  private maxEntries: number;

  constructor(maxEntries: number = 100) {
    this.maxEntries = maxEntries;
  }

  /**
   * Returns true if this content has been seen before (duplicate).
   */
  isDuplicate(content: string, scope: string = 'default'): boolean {
    if (this.has(content, scope)) return true;
    this.record(content, scope);
    return false;
  }

  has(content: string, scope: string = 'default'): boolean {
    return (this.hashesByScope.get(scope) ?? []).includes(this.hash(content));
  }

  record(content: string, scope: string = 'default'): void {
    const hash = this.hash(content);
    const hashes = this.hashesByScope.get(scope) ?? [];
    if (hashes.includes(hash)) return;
    hashes.push(hash);
    if (hashes.length > this.maxEntries) {
      hashes.shift();
    }
    this.hashesByScope.set(scope, hashes);
  }

  remove(content: string, scope: string = 'default'): void {
    const hash = this.hash(content);
    const hashes = (this.hashesByScope.get(scope) ?? []).filter((entry) => entry !== hash);
    if (hashes.length === 0) this.hashesByScope.delete(scope);
    else this.hashesByScope.set(scope, hashes);
  }

  clear(): void {
    this.hashesByScope.clear();
  }

  private hash(content: string): string {
    return createHash('md5').update(content).digest('hex');
  }
}

// C0 control characters (except \t \n \r), DEL, and the C1 control block
// (\x80-\x9f). ESC (0x1b) is the critical C0 — see sanitizeForInjection
// below. The C1 block matters because 8-bit CSI (\x9b, U+009B) is the
// single-byte equivalent of ESC[ in some terminal modes: "\x9b201~" can
// act as the bracketed-paste END marker exactly like "\x1b[201~", the
// same paste-breakout class already closed for 7-bit ESC. Stripping
// targets code points U+0080-U+009F only — printable Latin-1/Unicode
// text (é, ñ, emoji, etc.) sits above U+009F and is untouched.
const CONTROL_CHARS = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f\x80-\x9f]/g;

/**
 * Strip control characters from message content before PTY injection.
 *
 * Bracketed paste only protects against PRINTABLE special characters.
 * If the content itself contains the paste-END marker (ESC [ 2 0 1 ~),
 * the terminal application sees the paste terminate early and interprets
 * the REMAINDER of the message as typed keystrokes — i.e. an attacker who
 * can get text delivered to an agent (Telegram message, bus message,
 * email subject relayed into a prompt) could embed escape sequences that
 * navigate TUI menus, auto-approve permission prompts, or submit
 * arbitrary commands. Stripping ESC and the other C0 controls (keeping
 * \t \n \r, which are legitimate in multi-line messages) closes the
 * breakout: "\x1b[201~" becomes the harmless literal "[201~". C1
 * controls (\x80-\x9f) are stripped for the same reason — 8-bit CSI
 * "\x9b201~" is an alternate encoding of the same paste-END breakout.
 */
export function sanitizeForInjection(content: string): string {
  return content.replace(CONTROL_CHARS, '');
}

/**
 * Inject a message into a PTY process using bracketed paste mode.
 * Replaces tmux load-buffer + paste-buffer pattern.
 *
 * Bracketed paste mode wraps the content so the terminal treats it as
 * pasted text rather than typed input. This prevents special characters
 * from being interpreted as commands. Content is first sanitized via
 * `sanitizeForInjection` so embedded escape sequences cannot terminate
 * the paste early and inject raw keystrokes.
 *
 * @param write Function to write to the PTY (pty.write)
 * @param content The message content to inject
 * @param enterDelay Milliseconds to wait before sending Enter (default 300ms)
 */
export function injectMessage(
  write: (data: string) => void,
  content: string,
  enterDelay: number = 300,
): void {
  content = sanitizeForInjection(content);
  // For very large messages, chunk the write to avoid overwhelming the PTY buffer
  const MAX_CHUNK = 4096;

  if (content.length <= MAX_CHUNK) {
    write(PASTE_START + content + PASTE_END);
  } else {
    // Chunked write for large messages
    write(PASTE_START);
    for (let i = 0; i < content.length; i += MAX_CHUNK) {
      write(content.slice(i, i + MAX_CHUNK));
    }
    write(PASTE_END);
  }

  // Send Enter after a short delay to submit the pasted content.
  // Why the try/catch: the write callback captures `this.pty` (or similar
  // nullable PTY handle) via closure in callers. If the PTY is torn down
  // during the enterDelay window — e.g. hard-restart IPC kills the child —
  // the callback will read `null.write` and throw. Swallowing here keeps
  // the daemon process alive; the dropped Enter is the acceptable cost.
  // Root cause: PR #196 fixed three this.pty! callers in agent-process.ts
  // but missed worker-process.ts:93. This try/catch is the structural fix
  // that covers every present and future caller.
  setTimeout(() => {
    try {
      write(KEYS.ENTER);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.warn(`[inject] deferred Enter failed (pty likely torn down): ${msg}`);
    }
  }, enterDelay);
}

/**
 * Send a sequence of keys to the PTY for TUI navigation.
 * Used for AskUserQuestion option selection and Plan mode approval.
 *
 * @param write Function to write to the PTY
 * @param keys Array of key sequences to send
 * @param delay Milliseconds between each key (default 100ms)
 */
export async function sendKeySequence(
  write: (data: string) => void,
  keys: string[],
  delay: number = 100,
): Promise<void> {
  for (const key of keys) {
    write(key);
    await sleep(delay);
  }
}

/**
 * Navigate to a specific option in a TUI list and select it.
 * Matches bash fast-checker.sh AskUserQuestion navigation.
 *
 * @param write PTY write function
 * @param optionIndex 0-based index of the option to select
 * @param submit Whether to press Enter after selection
 */
export async function selectOption(
  write: (data: string) => void,
  optionIndex: number,
  submit: boolean = true,
): Promise<void> {
  // Navigate down to the option
  for (let i = 0; i < optionIndex; i++) {
    write(KEYS.DOWN);
    await sleep(100);
  }
  await sleep(200);

  if (submit) {
    write(KEYS.ENTER);
  }
}

/**
 * Toggle options for multi-select TUI and submit.
 * Matches bash fast-checker.sh multi-select pattern.
 */
export async function toggleAndSubmit(
  write: (data: string) => void,
  selectedIndices: number[],
  totalOptions: number,
): Promise<void> {
  const sorted = [...selectedIndices].sort((a, b) => a - b);
  let currentPos = 0;

  for (const idx of sorted) {
    const moves = idx - currentPos;
    for (let i = 0; i < moves; i++) {
      write(KEYS.DOWN);
      await sleep(100);
    }
    write(KEYS.SPACE);
    await sleep(100);
    currentPos = idx;
  }

  // Navigate to Submit button (past all options + "Other")
  const submitPos = totalOptions + 1;
  const remaining = submitPos - currentPos;
  for (let i = 0; i < remaining; i++) {
    write(KEYS.DOWN);
    await sleep(100);
  }
  await sleep(200);
  write(KEYS.ENTER);
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
