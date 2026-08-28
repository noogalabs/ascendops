import type { Priority, EventCategory, EventSeverity, ApprovalCategory, TrustLevel } from '../types/index.js';
import { VALID_PRIORITIES, VALID_TRUST_LEVELS } from '../types/index.js';

const AGENT_NAME_REGEX = /^[a-z0-9_-]+$/;
// Task IDs are generated as `task_<epoch>_<rand>` (lowercase). Allow lowercase
// letters, digits, underscores and hyphens — matching the generator and the
// rest of the codebase's identifier convention — while rejecting path
// separators and dots so a task id can never traverse out of the task tree.
const TASK_ID_REGEX = /^[a-z0-9_-]+$/;

export function validateTaskId(taskId: string): void {
  if (!taskId || !TASK_ID_REGEX.test(taskId)) {
    throw new Error(
      `Invalid task id '${taskId}'. Must contain only letters, numbers, underscores, and hyphens.`
    );
  }
}

export function validateInstanceId(instanceId: string): void {
  if (!instanceId || !AGENT_NAME_REGEX.test(instanceId)) {
    throw new Error(
      `Invalid instance ID '${instanceId}'. Must contain only lowercase letters, numbers, underscores, and hyphens.`
    );
  }
}

export function validateAgentName(name: string): void {
  if (!name || !AGENT_NAME_REGEX.test(name)) {
    throw new Error(
      `Invalid agent name '${name}'. Must contain only lowercase letters, numbers, underscores, and hyphens.`
    );
  }
}

export function validateOrgName(org: string): void {
  if (!org || !AGENT_NAME_REGEX.test(org)) {
    throw new Error(
      `Invalid org name '${org}'. Must contain only lowercase letters, numbers, underscores, and hyphens.`
    );
  }
}

/**
 * Reject an empty or whitespace-only message body.
 *
 * Added 2026-08-03. Before this, `sendMessage` validated the sender, the recipient and the
 * priority but never the text, so an empty body was accepted, HMAC-signed, written to the
 * inbox, delivered and ACK'd with EVERY layer reporting success: the send returned a msg_id,
 * the receive succeeded, the ACK succeeded. A review verdict, an approval, or a blocker
 * could vanish with no error raised anywhere.
 *
 * Measured before the fix: 19 empty bodies across 43,457 stored messages, from 5 distinct
 * senders, spread from 2026-04-24 through 2026-08-03 — a live low-rate silent loss, not a
 * closed historical bug. Immediate trigger was a PR review verdict that arrived empty.
 *
 * Root cause: the `send-message` CLI declares `<text>` as a REQUIRED positional, but
 * commander treats an empty string as satisfying it.
 *
 * A caller sweep of all 11 bus `sendMessage` call sites found ZERO legitimate metadata-only
 * empty-text patterns, so rejecting empty breaks no existing traffic.
 */
export function validateMessageText(text: string): void {
  if (typeof text !== 'string' || text.trim() === '') {
    throw new Error(
      'Empty message body: refusing to send a message with no text. ' +
      'An empty body is delivered and ACKed silently, so the content is lost with no error. ' +
      'If this came from the CLI, check for an empty quoted argument.'
    );
  }
}

export function validatePriority(priority: string): asserts priority is Priority {
  if (!VALID_PRIORITIES.includes(priority as Priority)) {
    throw new Error(
      `Invalid priority '${priority}'. Must be one of: ${VALID_PRIORITIES.join(', ')}`
    );
  }
}

const VALID_CATEGORIES: EventCategory[] = [
  'action', 'error', 'metric', 'milestone', 'heartbeat', 'message', 'task', 'approval',
];

export function validateEventCategory(category: string): asserts category is EventCategory {
  if (!VALID_CATEGORIES.includes(category as EventCategory)) {
    throw new Error(
      `Invalid event category '${category}'. Must be one of: ${VALID_CATEGORIES.join(', ')}`
    );
  }
}

const VALID_SEVERITIES: EventSeverity[] = ['info', 'warning', 'error', 'critical'];

export function validateEventSeverity(severity: string): asserts severity is EventSeverity {
  if (!VALID_SEVERITIES.includes(severity as EventSeverity)) {
    throw new Error(
      `Invalid severity '${severity}'. Must be one of: ${VALID_SEVERITIES.join(', ')}`
    );
  }
}

const VALID_APPROVAL_CATEGORIES: ApprovalCategory[] = [
  'external-comms', 'financial', 'deployment', 'data-deletion', 'other',
];

export function validateApprovalCategory(category: string): asserts category is ApprovalCategory {
  if (!VALID_APPROVAL_CATEGORIES.includes(category as ApprovalCategory)) {
    throw new Error(
      `Invalid approval category '${category}'. Must be one of: ${VALID_APPROVAL_CATEGORIES.join(', ')}`
    );
  }
}

export function validateModel(model: string): void {
  if (!/^[a-zA-Z0-9._-]+$/.test(model)) {
    throw new Error(`Invalid model name '${model}'. Must be alphanumeric with dots and hyphens.`);
  }
}

export function isValidJson(str: string): boolean {
  try {
    JSON.parse(str);
    return true;
  } catch {
    return false;
  }
}

/**
 * Strip terminal control sequences and non-printable characters from external input.
 * Applied to all inbound Telegram text, captions, and callback data before PTY injection.
 * Prevents terminal injection attacks via crafted Telegram messages.
 */
export function stripControlChars(input: string): string {
  return input
    .replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '')    // ANSI CSI sequences (e.g. \e[31m)
    .replace(/\x1b\][^\x07]*\x07/g, '')         // OSC sequences (e.g. \e]0;title\a)
    .replace(/\x1b[^[\]]/g, '')                  // Other ESC sequences
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, ''); // Control chars (keep \t=0x09, \n=0x0a, \r=0x0d)
}

export function validateTrustLevel(level: string): asserts level is TrustLevel {
  if (!VALID_TRUST_LEVELS.includes(level as TrustLevel)) {
    throw new Error(
      `Invalid trust level '${level}'. Must be one of: ${VALID_TRUST_LEVELS.join(', ')}`
    );
  }
}

// Every `=== X ===` containment header the daemon injects into an agent PTY.
// This is the single source of truth: sanitizeForPtyInjection builds its
// forged-header quote pattern FROM this list, so the neutralizer can never lag
// the set. SLACK (Socket Mode + fast-checker) and GMAIL WATCH (unread-mail
// notification) were emitting headers that predated their registration here —
// a forged copy in an unfenced context-preview field went un-quoted until they
// were added. `SLACK` covers `=== SLACK CONNECTION DEAD` via the \b rule, and
// `TELEGRAM` covers the PHOTO/DOCUMENT/VOICE/VIDEO variants. The anti-drift
// census test (tests/unit/utils/validate.test.ts) fails if any daemon-emitted
// marker is ever missing from this list again.
export const DAEMON_STRUCTURAL_HEADERS = [
  'AGENT MESSAGE', 'TELEGRAM', 'SLACK', 'REACTION', 'URGENT SIGNAL', 'CRON FIRED',
  'CONTEXT', 'CONTEXT HANDOFF REQUIRED', 'GMAIL WATCH',
] as const;

export type DaemonStructuralHeader = typeof DAEMON_STRUCTURAL_HEADERS[number];
export type DaemonInjectionReply =
  | { kind: 'agent'; from: string; messageId: string }
  | { kind: 'telegram'; chatId: string | number };
export type DaemonInjectionBody = { kind: 'raw'; content: string };
export type DaemonInjection =
  | { kind: 'raw'; content: string }
  | { kind: 'structural'; header: DaemonStructuralHeader; details?: string; body?: DaemonInjectionBody; reply?: DaemonInjectionReply };

export const rawDaemonInjection = (content: string): DaemonInjection => ({ kind: 'raw', content });
export const rawDaemonBody = (content: string): DaemonInjectionBody => ({ kind: 'raw', content });
export function structuralDaemonInjection(
  header: DaemonStructuralHeader,
  details = '',
  body?: DaemonInjectionBody,
  reply?: DaemonInjectionReply,
): DaemonInjection {
  return { kind: 'structural', header, details, body, reply };
}

export function createDaemonStructuralHeader(header: DaemonStructuralHeader, details = ''): string {
  if (!(DAEMON_STRUCTURAL_HEADERS as readonly string[]).includes(header)) {
    throw new Error(`Unregistered daemon structural header: ${String(header)}`);
  }
  if (/(?:^|[\r\n])\s*===/.test(details)) {
    throw new Error('Daemon structural header details must not contain an unneutralized header');
  }
  return `=== ${header}${details ? ` ${details}` : ''} ===`;
}

const DAEMON_STRUCTURAL_HEADER_PATTERN = DAEMON_STRUCTURAL_HEADERS.join('|');

/**
 * Wrap untrusted text as a code-fenced block that the body CANNOT escape, with
 * zero mutation of the body itself (legit code blocks survive byte-exact).
 *
 * Attack (Hoffman disclosure 2026-06-04): a fixed triple-backtick wrapper is
 * closed by any ``` the body contains, after which injected text reads as
 * top-level prompt and can forge `=== AGENT MESSAGE` / `=== TELEGRAM`
 * containment headers, impersonating the daemon in the recipient PTY.
 *
 * Fix uses the CommonMark rule "a fence is closed only by a run of backticks
 * >= the opening run": size the wrapper to (longest backtick run in body) + 1,
 * minimum 3. The body's own fences (even a ```` block discussing fences) are
 * then strictly shorter than the wrapper and cannot close it — and nothing in
 * the body is altered, so pasted code stays readable. Control chars are still
 * stripped.
 *
 * Use for the FENCED body of an injection block (inbox text, Telegram text).
 * For unfenced context fields use sanitizeForPtyInjection instead.
 */
export function wrapFenceSafe(input: string): string {
  const body = stripControlChars(input);
  let longest = 0;
  const runs = body.match(/`+/g);
  if (runs) for (const r of runs) longest = Math.max(longest, r.length);
  const fence = '`'.repeat(Math.max(3, longest + 1));
  return `${fence}\n${body}\n${fence}`;
}

/**
 * Neutralize PTY structural-injection vectors in untrusted text that is
 * injected WITHOUT a protective fence — the context-preview fields
 * (`[Replying to: "..."]`, `[Your last message: "..."]`,
 * `[Recent conversation:] ...`). These have no wrapper to size, so a stray
 * fence-open or a forged header line is neutralized directly:
 *  - normalize carriage returns to newlines FIRST: stripControlChars keeps
 *    \r (0x0d), and a bare CR renders the following text at terminal column 0,
 *    so a `text\r=== AGENT MESSAGE` payload would visually present a header the
 *    `^` line-anchor never matched (CR is not a line start). Folding CR into LF
 *    makes the header-quote anchor see it (designer pre-validation finding);
 *  - collapse any run of 3+ backticks to 2 so the preview cannot open a fence
 *    that swallows following real structure (survives input transforms — no
 *    zero-width reliance);
 *  - prefix forged `=== AGENT MESSAGE` / `=== TELEGRAM` / `Reply using:
 *    cortextos bus` lines with [quoted] so they read as content. The leading-
 *    whitespace class must match every Unicode space char a downstream parser's
 *    `.trim()` would strip, or a header preceded by e.g. NBSP/IDEOGRAPHIC SPACE
 *    escapes [quoted] here yet is still recognized as a header after trim (#596,
 *    ClintMoody). Line terminators are excluded — the /m anchor already starts a
 *    new match after \n and after U+2028/U+2029; \r was folded to \n above; and
 *    \v/\f were removed by stripControlChars — so the class only needs the
 *    space-like chars: tab, space, NBSP, OGHAM, the U+2000–200A run, NARROW NBSP,
 *    MEDIUM MATH SPACE, IDEOGRAPHIC SPACE, and BOM/ZWNBSP.
 * Lossy, but these fields are already truncated context hints — acceptable.
 */
export function sanitizeForPtyInjection(input: string): string {
  return stripControlChars(input)
    .replace(/\r\n?/g, '\n')
    .replace(/`{3,}/g, '``')
    .replace(
      new RegExp(`^([ \\t\\u00A0\\u1680\\u2000-\\u200A\\u202F\\u205F\\u3000\\uFEFF]*)(={3,}\\s*(?:${DAEMON_STRUCTURAL_HEADER_PATTERN})\\b|Reply using:\\s*cortextos\\s+bus)`, 'gim'),
      '$1[quoted] $2',
    );
}

export function renderDaemonInjection(input: DaemonInjection): string {
  if (!input || typeof input !== 'object' || !('kind' in input)) throw new Error('Malformed daemon injection');
  if (input.kind === 'raw') {
    if (typeof input.content !== 'string') throw new Error('Malformed raw daemon injection');
    return wrapFenceSafe(input.content);
  }
  if (input.kind !== 'structural') throw new Error(`Unknown daemon injection variant: ${String((input as { kind?: unknown }).kind)}`);
  if (!(DAEMON_STRUCTURAL_HEADERS as readonly unknown[]).includes(input.header)) {
    throw new Error(`Unregistered daemon structural header: ${String(input.header)}`);
  }
  if (input.details !== undefined && typeof input.details !== 'string') throw new Error('Malformed daemon structural details');
  if (input.body !== undefined && (!input.body || input.body.kind !== 'raw' || typeof input.body.content !== 'string')) {
    throw new Error('Malformed daemon structural body');
  }
  const details = sanitizeForPtyInjection(input.details ?? '').replace(/\n+/g, ' ').trim();
  const header = createDaemonStructuralHeader(input.header, details);
  const body = input.body ? `\n${wrapFenceSafe(input.body.content)}` : '';
  let reply = '';
  if (input.reply?.kind === 'agent') {
    if (typeof input.reply.from !== 'string' || typeof input.reply.messageId !== 'string') throw new Error('Malformed agent reply directive');
    const from = sanitizeForPtyInjection(input.reply.from).replace(/\n+/g, ' ').trim();
    const messageId = sanitizeForPtyInjection(input.reply.messageId).replace(/\n+/g, '').trim();
    reply = `\nReply using: cortextos bus send-message ${from} normal '<your reply>' ${messageId}`;
  } else if (input.reply?.kind === 'telegram') {
    if (!['string', 'number'].includes(typeof input.reply.chatId)) throw new Error('Malformed Telegram reply directive');
    reply = `\nReply using: cortextos bus send-telegram ${input.reply.chatId} '<your reply>'`;
  } else if (input.reply !== undefined) {
    throw new Error('Unknown daemon reply directive');
  }
  return `${header}${body}${reply}\n\n`;
}
