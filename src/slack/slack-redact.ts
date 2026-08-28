// Token-shape redaction. The structural-credential patterns are lifted from
// oh-my-claudecode (src/notifications/redact.ts).
// Source: https://github.com/Yeachan-Heo/oh-my-claudecode
// License: MIT — Copyright (c) 2025 Yeachan Heo. Lifted into cortextOS 2026-06-01.
import { redactSSN } from '../utils/ssn-redaction.js';

/**
 * Token Redaction Utility
 *
 * Masks sensitive tokens in strings to prevent exposure in logs, error messages,
 * and persisted state. Covers Slack, Telegram, and generic Bearer/Bot tokens.
 *
 * @see https://github.com/Yeachan-Heo/oh-my-claudecode/issues/1162
 */

/**
 * Redact sensitive tokens from a string.
 *
 * Patterns masked:
 * - Slack bot tokens: xoxb-...
 * - Slack app tokens: xapp-...
 * - Slack user/workspace/session/client/refresh tokens: xoxp-, xoxa-, xoxs-, xoxc-, xoxr-
 * - Slack incoming-webhook URLs: hooks.slack.com/services/T.../B.../secret
 * - Telegram bot tokens in URL paths: /bot123456:ABC.../method
 * - Telegram bot tokens standalone: 123456789:AAF-abc123...
 * - Bearer and Bot authorization values
 */
/**
 * Structurally-unambiguous credential shapes only — patterns that cannot match
 * ordinary prose. Safe to run on untrusted user text. Does NOT include the
 * loose Bearer/Bot heuristics (see redactTokens).
 */
function redactStructuralCredentials(input: string): string {
  return input
    // Slack tokens: xoxb-, xapp-, xoxp-, xoxa-, xoxs- (session), xoxc- (client),
    // xoxr- (refresh), xoxe- (export)
    .replace(/\b(xox[bpaescr]-)[A-Za-z0-9-]+/g, '$1****')
    .replace(/\b(xapp-)[A-Za-z0-9-]+/g, '$1****')
    // Slack incoming-webhook URLs — the path segments ARE the secret
    .replace(/(hooks\.slack\.com\/services\/)[A-Za-z0-9/]+/g, '$1****')
    // Telegram bot tokens in URL paths: /bot123456:ABC.../
    .replace(/\/bot(\d+):[A-Za-z0-9_-]+/g, '/bot$1:****')
    // Telegram bot tokens standalone: 123456789:AAHfoo-bar_Baz
    .replace(/\b(\d{8,12}):[A-Za-z0-9_-]{20,}\b/g, '$1:****')
    // Anthropic API keys: sk-ant-api...
    .replace(/\b(sk-ant-api)[A-Za-z0-9_-]+/g, '$1****')
    // GitHub tokens: ghp_, gho_, ghs_, github_pat_
    .replace(/\b(ghp_)[A-Za-z0-9]+/g, '$1****')
    .replace(/\b(gho_)[A-Za-z0-9]+/g, '$1****')
    .replace(/\b(ghs_)[A-Za-z0-9]+/g, '$1****')
    .replace(/\b(github_pat_)[A-Za-z0-9_]+/g, '$1****')
    // AWS access key IDs: AKIA...
    .replace(/\b(AKIA)[A-Z0-9]{16}\b/g, '$1****');
}

/**
 * LOG/ERROR-STRING redaction. Includes the loose `Bearer <x>` / `Bot <x>`
 * heuristics — appropriate for logs and error messages, but they match ordinary
 * words ("tell the bot not to..."), so they MUST NOT run on user prose. For
 * untrusted inbound text use redactInboundText instead.
 */
export function redactTokens(input: string): string {
  return redactStructuralCredentials(input)
    .replace(/(Bearer\s+)\S+/gi, '$1****')
    .replace(/(Bot\s+)\S+/gi, '$1****');
}

/**
 * Redact credentials from UNTRUSTED INBOUND TEXT before it is persisted or read
 * by an agent. Applies ONLY structurally-unambiguous credential shapes (Slack /
 * Telegram / Anthropic / GitHub / AWS token shapes) plus SSNs — never the loose
 * Bearer/Bot heuristics, which would corrupt prose and can INVERT meaning
 * ("tell the bot not to delete" -> "tell the bot **** to delete").
 */
export function redactInboundText(input: string): string {
  return redactSSN(redactStructuralCredentials(input));
}
