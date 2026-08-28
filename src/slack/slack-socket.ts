// Lifted near-verbatim from oh-my-claudecode (src/notifications/slack-socket.ts).
// Source: https://github.com/Yeachan-Heo/oh-my-claudecode
// License: MIT — Copyright (c) 2025 Yeachan Heo.
// Lifted into cortextOS 2026-06-01 for the Slack team-surface P1 (transport swap).
// Modifications vs upstream:
//   (1) import path ./redact.js -> ./slack-redact.js;
//   (2) validateSlackEnvelope exempts the `hello`/`disconnect` control frames
//       from the envelope_id requirement — those frames carry no envelope_id,
//       so the upstream check rejected `hello` and the connection never
//       authenticated (onAuthenticated was unreachable).
//   (3) connect() re-checks isShuttingDown after the apps.connections.open
//       await, before creating the WebSocket — upstream could create a socket
//       after stop() landed mid-fetch (a ghost listener on the restart path).
//   (4) message filter delivers non-bot subtyped messages (file_share etc.),
//       matching the legacy poll — upstream dropped ALL subtyped events, which
//       would silently lose human file/photo shares (shouldDeliverSlackMessage).
//   (5) reconnection never gives up permanently — past maxReconnectAttempts the
//       client keeps retrying at the max backoff delay instead of returning.
//       Upstream stopped forever after ~3 minutes of outage, which (with the
//       poll dormant while Socket Mode is primary) silently killed ALL Slack
//       inbound until a daemon restart.
//   (6) connect() checks the HTTP status of apps.connections.open and honors a
//       429 Retry-After as a floor on the next reconnect delay; start() resets
//       isShuttingDown so a stopped client can be restarted.
//   (7) a WebSocket open-timeout watchdog recycles connections that never
//       reach 'open' (black-holed TCP / stalled TLS would otherwise hang the
//       client forever with no event ever firing).
//   (8) PERMANENT auth-class failures from apps.connections.open (invalid_auth,
//       token_revoked, etc. — see SLACK_PERMANENT_AUTH_ERRORS) STOP the
//       reconnect loop instead of retrying forever: a dead token returns HTTP
//       200 ok:false and will NEVER self-heal, so retry-forever would just
//       log-spam every 30s while silently masking a config error. The client
//       latches a fatal state (getFatalAuthError), logs a loud ERROR, and
//       invokes onFatalAuthError so the daemon can alert the operator.
//       Transient failures (network, 5xx, 429, non-auth ok:false) keep the
//       retry-forever behavior of (5).

/**
 * Slack Socket Mode Client
 *
 * Minimal implementation of Slack Socket Mode for receiving messages.
 * Uses Node.js built-in WebSocket (available in Node 20+) to avoid
 * adding heavy SDK dependencies.
 *
 * Protocol:
 * 1. POST apps.connections.open with app-level token to get WSS URL
 * 2. Connect via WebSocket
 * 3. Receive envelope events, send acknowledgements
 * 4. Handle reconnection with exponential backoff
 *
 * Security:
 * - App-level token (xapp-...) only used for Socket Mode WebSocket
 * - Bot token (xoxb-...) only used for Web API calls
 * - Channel filtering ensures messages from other channels are ignored
 * - HMAC-SHA256 signing secret verification (Slack v0 signatures)
 * - Timestamp-based replay attack prevention (5-minute window)
 * - Message envelope structure validation
 * - Connection state tracking (reject messages during reconnection windows)
 *
 * References:
 * - https://api.slack.com/authentication/verifying-requests-from-slack
 * - https://api.slack.com/apis/socket-mode
 */

import { createHmac, timingSafeEqual } from 'crypto';
import { redactSSN } from '../utils/ssn-redaction.js';

// ============================================================================
// Constants
// ============================================================================

/** Maximum age for request timestamps (5 minutes, per Slack docs) */
const MAX_TIMESTAMP_AGE_SECONDS = 300;

/** Valid Slack Socket Mode envelope types */
const VALID_ENVELOPE_TYPES = new Set([
  'events_api',
  'slash_commands',
  'interactive',
  'hello',
  'disconnect',
]);

// ============================================================================
// Validation Types
// ============================================================================

/** Connection states for Slack Socket Mode */
export type SlackConnectionState =
  | 'disconnected'
  | 'connecting'
  | 'authenticated'
  | 'reconnecting';

/** Result of message validation */
export interface SlackValidationResult {
  valid: boolean;
  reason?: string;
}

/** Slack Socket Mode message envelope */
export interface SlackSocketEnvelope {
  envelope_id: string;
  type: string;
  payload?: Record<string, unknown>;
  accepts_response_payload?: boolean;
  retry_attempt?: number;
  retry_reason?: string;
}

// ============================================================================
// Signing Secret Verification
// ============================================================================

/**
 * Verify Slack request signature using HMAC-SHA256.
 *
 * Implements Slack's v0 signing verification:
 *   sig_basestring = 'v0:' + timestamp + ':' + body
 *   signature = 'v0=' + HMAC-SHA256(signing_secret, sig_basestring)
 *
 * Uses timing-safe comparison to prevent timing attacks.
 * Includes replay protection via timestamp validation.
 */
export function verifySlackSignature(
  signingSecret: string,
  signature: string,
  timestamp: string,
  body: string,
): boolean {
  if (!signingSecret || !signature || !timestamp) {
    return false;
  }

  // Replay protection: reject stale timestamps
  if (!isTimestampValid(timestamp)) {
    return false;
  }

  const sigBasestring = `v0:${timestamp}:${body}`;
  const expectedSignature =
    'v0=' +
    createHmac('sha256', signingSecret).update(sigBasestring).digest('hex');

  // Timing-safe comparison to prevent timing attacks
  try {
    return timingSafeEqual(
      Buffer.from(expectedSignature),
      Buffer.from(signature),
    );
  } catch {
    // Buffer length mismatch means signatures don't match
    return false;
  }
}

// ============================================================================
// Timestamp Validation
// ============================================================================

/**
 * Check if a request timestamp is within the acceptable window.
 *
 * Rejects timestamps older than maxAgeSeconds (default: 5 minutes)
 * to prevent replay attacks.
 */
export function isTimestampValid(
  timestamp: string,
  maxAgeSeconds: number = MAX_TIMESTAMP_AGE_SECONDS,
): boolean {
  const requestTime = parseInt(timestamp, 10);
  if (isNaN(requestTime)) {
    return false;
  }

  const now = Math.floor(Date.now() / 1000);
  return Math.abs(now - requestTime) <= maxAgeSeconds;
}

// ============================================================================
// Envelope Validation
// ============================================================================

/**
 * Validate Slack Socket Mode message envelope structure.
 *
 * Ensures the message has required fields and a valid type
 * before it can be processed for session injection.
 */
export function validateSlackEnvelope(
  data: unknown,
): SlackValidationResult {
  if (typeof data !== 'object' || data === null) {
    return { valid: false, reason: 'Message is not an object' };
  }

  const envelope = data as Record<string, unknown>;

  // type is required for all frames.
  if (typeof envelope.type !== 'string' || !envelope.type.trim()) {
    return { valid: false, reason: 'Missing or empty message type' };
  }

  // Validate against known Slack Socket Mode types
  if (!VALID_ENVELOPE_TYPES.has(envelope.type)) {
    return {
      valid: false,
      reason: `Unknown envelope type: ${envelope.type}`,
    };
  }

  // envelope_id is required ONLY for frames that must be acknowledged
  // (events_api, slash_commands, interactive). Slack's `hello` and `disconnect`
  // control frames carry no envelope_id — requiring it for every type rejected
  // the opening `hello` frame, so onAuthenticated() never fired and the
  // connection stayed unauthenticated (all events queued forever).
  const requiresEnvelopeId =
    envelope.type !== 'hello' && envelope.type !== 'disconnect';
  if (
    requiresEnvelopeId &&
    (typeof envelope.envelope_id !== 'string' || !envelope.envelope_id.trim())
  ) {
    return { valid: false, reason: 'Missing or empty envelope_id' };
  }

  // events_api type must have a payload
  if (envelope.type === 'events_api') {
    if (typeof envelope.payload !== 'object' || envelope.payload === null) {
      return {
        valid: false,
        reason: 'events_api envelope missing payload',
      };
    }
  }

  return { valid: true };
}

// ============================================================================
// Connection State Tracker
// ============================================================================

/**
 * Connection state tracker for Slack Socket Mode.
 *
 * Tracks authentication status across the connection lifecycle:
 * - disconnected: No WebSocket connection
 * - connecting: WebSocket opening, not yet authenticated
 * - authenticated: Hello message received, ready to process
 * - reconnecting: Connection lost, attempting to re-establish
 *
 * Messages are ONLY processed in the 'authenticated' state.
 * This prevents injection during reconnection windows where
 * authentication has not been re-established.
 */
export class SlackConnectionStateTracker {
  private state: SlackConnectionState = 'disconnected';
  private authenticatedAt: number | null = null;
  private reconnectCount = 0;
  private readonly maxReconnectAttempts: number;
  private messageQueue: SlackSocketEnvelope[] = [];
  private readonly maxQueueSize: number;

  constructor(options?: {
    maxReconnectAttempts?: number;
    maxQueueSize?: number;
  }) {
    this.maxReconnectAttempts = options?.maxReconnectAttempts ?? 5;
    this.maxQueueSize = options?.maxQueueSize ?? 100;
  }

  getState(): SlackConnectionState {
    return this.state;
  }

  getReconnectCount(): number {
    return this.reconnectCount;
  }

  getAuthenticatedAt(): number | null {
    return this.authenticatedAt;
  }

  /** Transition to connecting state. */
  onConnecting(): void {
    this.state = 'connecting';
  }

  /**
   * Transition to authenticated state (received 'hello' message).
   * Resets reconnect counter on successful authentication.
   */
  onAuthenticated(): void {
    this.state = 'authenticated';
    this.authenticatedAt = Date.now();
    this.reconnectCount = 0;
  }

  /**
   * Transition to reconnecting state.
   * Increments reconnect counter and clears authentication timestamp.
   */
  onReconnecting(): void {
    this.state = 'reconnecting';
    this.reconnectCount++;
    this.authenticatedAt = null;
  }

  /**
   * Transition to disconnected state.
   * Clears message queue to prevent processing stale messages.
   */
  onDisconnected(): void {
    this.state = 'disconnected';
    this.authenticatedAt = null;
    this.messageQueue = [];
  }

  /** Check if maximum reconnection attempts have been exceeded. */
  hasExceededMaxReconnects(): boolean {
    return this.reconnectCount >= this.maxReconnectAttempts;
  }

  /**
   * Check if messages can be safely processed in the current state.
   * Only allows processing when the connection is authenticated.
   */
  canProcessMessages(): boolean {
    return this.state === 'authenticated';
  }

  /**
   * Queue a message for processing after reconnection.
   * Drops oldest messages when queue exceeds maxQueueSize to
   * prevent unbounded memory growth.
   *
   * Returns true if queued, false if queue is at capacity (oldest was dropped).
   */
  queueMessage(envelope: SlackSocketEnvelope): boolean {
    const wasFull = this.messageQueue.length >= this.maxQueueSize;
    if (wasFull) {
      this.messageQueue.shift();
    }
    this.messageQueue.push(envelope);
    return !wasFull;
  }

  /**
   * Drain the message queue (called after re-authentication).
   * Returns queued messages and clears the queue.
   */
  drainQueue(): SlackSocketEnvelope[] {
    const messages = [...this.messageQueue];
    this.messageQueue = [];
    return messages;
  }

  /** Get current queue size. */
  getQueueSize(): number {
    return this.messageQueue.length;
  }
}

// ============================================================================
// Top-Level Validation
// ============================================================================

/**
 * Validate a Slack WebSocket message before session injection.
 *
 * Performs all validation checks in order:
 * 1. Connection state verification (must be authenticated)
 * 2. JSON parsing
 * 3. Message envelope structure validation
 * 4. Signing secret verification (when signing material is provided)
 *
 * Returns validation result with reason on failure.
 */
export function validateSlackMessage(
  rawMessage: string,
  connectionState: SlackConnectionStateTracker,
  signingSecret?: string,
  signature?: string,
  timestamp?: string,
): SlackValidationResult {
  // 1. Check connection state - reject during reconnection windows
  if (!connectionState.canProcessMessages()) {
    return {
      valid: false,
      reason: `Connection not authenticated (state: ${connectionState.getState()})`,
    };
  }

  // 2. Parse message
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawMessage);
  } catch {
    return { valid: false, reason: 'Invalid JSON message' };
  }

  // 3. Validate envelope structure
  const envelopeResult = validateSlackEnvelope(parsed);
  if (!envelopeResult.valid) {
    return envelopeResult;
  }

  // 4. Verify signing secret (when signing material is provided)
  if (signingSecret && signature && timestamp) {
    if (
      !verifySlackSignature(signingSecret, signature, timestamp, rawMessage)
    ) {
      return { valid: false, reason: 'Signature verification failed' };
    }
  } else if (signingSecret && (!signature || !timestamp)) {
    // Signing secret is configured but signing material is missing
    return {
      valid: false,
      reason: 'Signing secret configured but signature/timestamp missing',
    };
  }

  return { valid: true };
}

/** Slack message event payload */
export interface SlackMessageEvent {
  type: string;
  channel: string;
  user: string;
  text: string;
  ts: string;
  thread_ts?: string;
  /**
   * Present when the message was authored by a bot (including messages this
   * agent posts via its own bot token). Used by {@link shouldDeliverSlackMessage}
   * to drop self-echoes.
   */
  bot_id?: string;
}

/**
 * Whether a Slack message event should be delivered to the inbox.
 *
 * Mirrors the legacy poll (checkSlackWatch), which delivered every message
 * EXCEPT `bot_message` (to avoid self-wake loops). Non-bot subtypes such as
 * `file_share` and `thread_broadcast` carry human content and WERE delivered by
 * the poll — dropping subtyped events here would silently lose human file/photo
 * shares on the normal receive path.
 *
 * A file/photo can be shared with NO caption, so `file_share` events may have
 * empty `text`; the poll woke on those too. So deliver any non-bot `message`
 * that has text OR is a `file_share` (captioned or not). Contentless events
 * (edits/deletes/system joins with neither text nor a file_share) are not
 * delivered. Channel scoping is applied by the caller.
 *
 * Self-echo guard: bot-authored messages are never delivered. The `bot_message`
 * subtype catches classic bot posts, but a message the agent posts itself via
 * its bot token arrives as a NORMAL `message` event with `bot_id` set (and
 * `user` = the app's own bot user id) and NO `bot_message` subtype — so it would
 * pass the subtype check and loop straight back into our own inbox. Dropping any
 * event carrying `bot_id` closes that self-echo path.
 */
export function shouldDeliverSlackMessage(
  event: { type?: string; subtype?: string; text?: string; bot_id?: string },
): boolean {
  if (event.type !== 'message' || event.subtype === 'bot_message' || event.bot_id) {
    return false;
  }
  return !!event.text || event.subtype === 'file_share';
}

/** Socket Mode configuration */
export interface SlackSocketConfig {
  appToken: string;
  botToken: string;
  channelId: string;
  /**
   * Multi-channel subscription (slack.json routing): when present, an event in
   * ANY listed channel is delivered and `channelId` is ignored for filtering.
   * Absent = legacy single-channel behavior, byte-for-byte.
   */
  channelIds?: string[];
  /** Optional signing secret for additional message verification */
  signingSecret?: string;
}

type MessageHandler = (event: SlackMessageEvent) => void | Promise<void>;
type LogFn = (message: string) => void;

import { redactTokens } from './slack-redact.js';

/** Timeout for Slack API calls */
const API_TIMEOUT_MS = 10_000;

/** Confirmation reaction timeout */
const REACTION_TIMEOUT_MS = 5_000;

/**
 * Timeout for a created WebSocket to reach 'open'. A black-holed TCP connect
 * or stalled TLS handshake fires NO event at all — without this watchdog the
 * client would sit in 'connecting' forever with reconnection never scheduled.
 */
const WS_OPEN_TIMEOUT_MS = 15_000;

/** Cap on a server-sent Retry-After honored as the next reconnect delay. */
const MAX_RETRY_AFTER_MS = 120_000;

/**
 * apps.connections.open `ok:false` error codes that are PERMANENT auth-class
 * failures. These mean the app-level token is invalid, revoked, expired, or
 * lacks the connections:write scope — a condition that will NEVER self-heal,
 * no matter how many times we retry. Reconnecting on these would log-spam
 * forever while silently masking a configuration error, so the client STOPS
 * and surfaces a fatal state instead.
 *
 * Codes (from Slack's apps.connections.open / common Web API error tables):
 * - invalid_auth:     token is invalid (wrong/garbled/deleted app token)
 * - account_inactive: the user/workspace behind the token was deactivated
 * - token_revoked:    token was explicitly revoked
 * - token_expired:    token has expired (refreshable app tokens)
 * - not_authed:       no token was provided at all
 * - no_permission:    token lacks the required scope (connections:write)
 *
 * Everything else (network errors, HTTP 5xx, 429 rate limits, transient
 * ok:false codes like internal_error / fatal_error) is treated as TRANSIENT
 * and keeps the persistent-reconnect behavior.
 */
export const SLACK_PERMANENT_AUTH_ERRORS: ReadonlySet<string> = new Set([
  'invalid_auth',
  'account_inactive',
  'token_revoked',
  'token_expired',
  'not_authed',
  'no_permission',
]);

/**
 * Minimal Slack Socket Mode client.
 *
 * Establishes a WebSocket connection to Slack's Socket Mode endpoint,
 * receives events, acknowledges them, and dispatches message events
 * to the registered handler.
 */
export class SlackSocketClient {
  private ws: WebSocket | null = null;
  private reconnectAttempts = 0;
  private readonly maxReconnectAttempts = 10;
  private readonly baseReconnectDelayMs = 1_000;
  private readonly maxReconnectDelayMs = 30_000;
  private isShuttingDown = false;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  // Watchdog for sockets that never reach 'open' (see WS_OPEN_TIMEOUT_MS).
  private openTimer: ReturnType<typeof setTimeout> | null = null;
  // Floor (ms) for the next reconnect delay, set when apps.connections.open
  // returns HTTP 429 with a Retry-After header; consumed by scheduleReconnect.
  private rateLimitMinDelayMs = 0;
  // Latched on a PERMANENT auth-class failure (see SLACK_PERMANENT_AUTH_ERRORS).
  // Non-null = reconnection is STOPPED until the operator fixes the token and
  // restarts (start() clears it). Queryable via getFatalAuthError() so the
  // daemon/heartbeat layer can surface the dead-token condition.
  private fatalAuthError: string | null = null;
  private readonly connectionState = new SlackConnectionStateTracker();

  // Bound listener references for proper removal on cleanup.
  // Typed as generic handlers for addEventListener/removeEventListener compat.
  private onWsOpen: ((...args: unknown[]) => void) | null = null;
  private onWsMessage: ((...args: unknown[]) => void) | null = null;
  private onWsClose: ((...args: unknown[]) => void) | null = null;
  private onWsError: ((...args: unknown[]) => void) | null = null;

  private readonly log: LogFn;

  constructor(
    private readonly config: SlackSocketConfig,
    private readonly onMessage: MessageHandler,
    log: LogFn,
    // Invoked ONCE when a permanent auth-class failure stops the reconnect
    // loop, so the embedding layer can alert the operator (Telegram/inbox).
    private readonly onFatalAuthError?: (errorCode: string) => void,
  ) {
    // Wrap the log function to automatically redact tokens from all messages
    this.log = (msg: string) => log(redactTokens(msg));
  }

  /** Get the connection state tracker for external inspection. */
  getConnectionState(): SlackConnectionStateTracker {
    return this.connectionState;
  }

  /**
   * The permanent auth-failure code that stopped reconnection, or null if the
   * connection has not hit a fatal auth error. Non-null means real-time Slack
   * inbound is DOWN and will not recover without operator action (fix the app
   * token, then restart). Heartbeat-surfaceable.
   */
  getFatalAuthError(): string | null {
    return this.fatalAuthError;
  }

  /**
   * Start the Socket Mode connection.
   * Obtains a WebSocket URL from Slack and connects.
   */
  async start(): Promise<void> {
    if (typeof WebSocket === 'undefined') {
      this.log('WARN: WebSocket not available, Slack Socket Mode requires Node 20.10+');
      return;
    }
    // Allow a stopped client to be restarted: stop() latches isShuttingDown,
    // and without resetting it here every post-stop start() would silently
    // no-op all connects and reconnects forever.
    this.isShuttingDown = false;
    // An explicit (re)start clears a latched fatal auth error: the operator's
    // recovery path is "fix the token, restart the agent" — the new start must
    // get a fresh chance to connect, not be blocked by the old token's fate.
    this.fatalAuthError = null;
    this.connectionState.onConnecting();
    await this.connect();
  }

  /**
   * Gracefully shut down the connection.
   */
  stop(): void {
    this.isShuttingDown = true;
    this.connectionState.onDisconnected();
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.cleanupWs();
  }

  /**
   * Remove all event listeners from the current WebSocket, close it,
   * and null the reference. Safe to call multiple times.
   */
  private cleanupWs(): void {
    // The open-timeout watchdog is tied to the socket being torn down — always
    // clear it (even when ws is already null) so a stale timer can never fire
    // against a connection that was already recycled.
    if (this.openTimer) {
      clearTimeout(this.openTimer);
      this.openTimer = null;
    }

    const ws = this.ws;
    if (!ws) return;

    this.ws = null;

    // Remove listeners before closing to prevent callbacks on dead socket
    if (this.onWsOpen) ws.removeEventListener('open', this.onWsOpen);
    if (this.onWsMessage) ws.removeEventListener('message', this.onWsMessage);
    if (this.onWsClose) ws.removeEventListener('close', this.onWsClose);
    if (this.onWsError) ws.removeEventListener('error', this.onWsError);
    this.onWsOpen = null;
    this.onWsMessage = null;
    this.onWsClose = null;
    this.onWsError = null;

    try {
      ws.close();
    } catch {
      // Ignore close errors on already-closed sockets
    }
  }

  /**
   * Establish WebSocket connection to Slack Socket Mode.
   */
  private async connect(): Promise<void> {
    if (this.isShuttingDown) return;
    this.connectionState.onConnecting();

    // Clean up any previous connection before creating a new one
    this.cleanupWs();

    try {
      // Step 1: Get WebSocket URL via apps.connections.open
      const resp = await fetch('https://slack.com/api/apps.connections.open', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${this.config.appToken}`,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        signal: AbortSignal.timeout(API_TIMEOUT_MS),
      });

      // Check the HTTP status BEFORE parsing: 429/5xx/proxy responses are often
      // non-JSON, and resp.json() on them throws an opaque SyntaxError. For a
      // 429, honor the server's Retry-After as a floor on the next reconnect
      // delay (capped) so backoff cannot hammer a rate-limited endpoint.
      if (!resp.ok) {
        if (resp.status === 429) {
          const retryAfterSec = Number(resp.headers.get('retry-after') ?? '');
          if (Number.isFinite(retryAfterSec) && retryAfterSec > 0) {
            this.rateLimitMinDelayMs = Math.min(retryAfterSec * 1000, MAX_RETRY_AFTER_MS);
          }
          throw new Error(
            `apps.connections.open rate limited (HTTP 429${this.rateLimitMinDelayMs ? `, retry after ${this.rateLimitMinDelayMs}ms` : ''})`,
          );
        }
        throw new Error(`apps.connections.open failed: HTTP ${resp.status}`);
      }

      const data = await resp.json() as { ok: boolean; url?: string; error?: string };

      // Classify ok:false BEFORE the generic throw: a dead/revoked/unscoped
      // token comes back as HTTP 200 ok:false (e.g. invalid_auth) and will
      // NEVER self-heal — retrying it forever at 30s just log-spams while
      // masking a config error. Permanent auth-class codes STOP the reconnect
      // loop and surface loudly; every other failure stays transient and falls
      // through to the throw -> catch -> scheduleReconnect retry-forever path.
      if (!data.ok && data.error && SLACK_PERMANENT_AUTH_ERRORS.has(data.error)) {
        this.handleFatalAuthError(data.error);
        return; // deliberate: NO scheduleReconnect — this cannot self-heal
      }

      if (!data.ok || !data.url) {
        throw new Error(`apps.connections.open failed: ${data.error || 'no url returned'}`);
      }

      // Re-check shutdown after the open fetch's await boundary. stop() may have
      // been called while apps.connections.open was in flight; without this guard
      // we would create a WebSocket after shutdown — a ghost listener that
      // authenticates post-stop and is never cleaned up (restart-path race).
      if (this.isShuttingDown) {
        this.log('Slack Socket Mode: shutdown during connection open — aborting before WebSocket creation');
        return;
      }

      // Step 2: Connect via WebSocket with tracked listeners
      this.ws = new WebSocket(data.url);

      this.onWsOpen = () => {
        if (this.openTimer) {
          clearTimeout(this.openTimer);
          this.openTimer = null;
        }
        this.log('Slack Socket Mode connected');
        this.reconnectAttempts = 0;
      };
      this.onWsMessage = (event) => {
        const ev = event as { data?: unknown };
        this.handleEnvelope(String(ev.data));
      };
      this.onWsClose = () => {
        this.cleanupWs();
        if (!this.isShuttingDown) {
          this.connectionState.onReconnecting();
          this.log('Slack Socket Mode disconnected, scheduling reconnect');
          this.scheduleReconnect();
        }
      };
      this.onWsError = (e) => {
        this.log(`Slack Socket Mode WebSocket error: ${e instanceof Error ? e.message : 'unknown'}`);
      };

      this.ws.addEventListener('open', this.onWsOpen);
      this.ws.addEventListener('message', this.onWsMessage);
      this.ws.addEventListener('close', this.onWsClose);
      this.ws.addEventListener('error', this.onWsError);

      // Half-open guard: if 'open' never fires (black-holed connect), no other
      // event will either — recycle the socket and go through normal backoff.
      // Cleared by onWsOpen on success and by cleanupWs on any teardown.
      this.openTimer = setTimeout(() => {
        this.openTimer = null;
        this.log(`Slack Socket Mode: WebSocket did not open within ${WS_OPEN_TIMEOUT_MS}ms — recycling connection`);
        this.cleanupWs();
        if (!this.isShuttingDown) {
          this.connectionState.onReconnecting();
          this.scheduleReconnect();
        }
      }, WS_OPEN_TIMEOUT_MS);

    } catch (error) {
      this.log(`Slack Socket Mode connection error: ${error instanceof Error ? error.message : String(error)}`);
      if (!this.isShuttingDown) {
        this.scheduleReconnect();
      }
    }
  }

  /**
   * Process a Socket Mode envelope.
   *
   * Envelope types:
   * - hello: connection established
   * - disconnect: server requesting reconnect
   * - events_api: contains event payloads (messages, etc.)
   */
  private handleEnvelope(raw: string): void {
    try {
      // Validate envelope structure before processing
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        this.log('REJECTED Slack message: Invalid JSON');
        return;
      }

      const envelopeValidation = validateSlackEnvelope(parsed);
      if (!envelopeValidation.valid) {
        this.log(`REJECTED Slack message: ${envelopeValidation.reason}`);
        return;
      }

      const envelope = parsed as {
        envelope_id: string;
        type: string;
        payload?: {
          event?: SlackMessageEvent & { subtype?: string };
        };
        reason?: string;
      };

      // Always acknowledge envelopes that have an ID
      if (envelope.envelope_id && this.ws?.readyState === WebSocket.OPEN) {
        this.ws.send(JSON.stringify({ envelope_id: envelope.envelope_id }));
      }

      // Handle hello - marks connection as authenticated
      if (envelope.type === 'hello') {
        this.connectionState.onAuthenticated();
        this.log('Slack Socket Mode authenticated (hello received)');

        // Drain any queued messages from reconnection window
        const queued = this.connectionState.drainQueue();
        if (queued.length > 0) {
          this.log(`Processing ${queued.length} queued messages after re-authentication`);
          for (const queuedEnvelope of queued) {
            this.handleEnvelope(JSON.stringify(queuedEnvelope));
          }
        }
        return;
      }

      // Handle disconnect requests from Slack
      if (envelope.type === 'disconnect') {
        this.connectionState.onReconnecting();
        this.log(`Slack requested disconnect: ${envelope.reason || 'unknown'}`);
        if (this.ws) {
          this.ws.close();
        }
        return;
      }

      // Reject messages during reconnection windows
      if (!this.connectionState.canProcessMessages()) {
        this.log(`REJECTED Slack message: connection not authenticated (state: ${this.connectionState.getState()})`);
        // Queue for processing after re-authentication
        this.connectionState.queueMessage(envelope as unknown as SlackSocketEnvelope);
        return;
      }

      // Verify signing secret if configured
      if (this.config.signingSecret) {
        // Socket Mode doesn't provide HTTP-style headers, but if signing
        // material is embedded in the envelope, verify it
        const envelopeAny = envelope as Record<string, unknown>;
        const sig = envelopeAny['x_slack_signature'] as string | undefined;
        const ts = envelopeAny['x_slack_request_timestamp'] as string | undefined;
        if (sig && ts) {
          if (!verifySlackSignature(this.config.signingSecret, sig, ts, raw)) {
            this.log('REJECTED Slack message: Signature verification failed');
            return;
          }
        }
      }

      // Process events_api envelopes containing message events
      if (envelope.type === 'events_api' && envelope.payload?.event) {
        const event = envelope.payload.event;

        // Deliver message events in our channel that the poll would have
        // delivered (non-bot, has text) — including human subtyped messages
        // like file_share. Channel scoping stays inline (needs config).
        const watchedChannels = this.config.channelIds ?? [this.config.channelId];
        if (
          watchedChannels.includes(event.channel) &&
          shouldDeliverSlackMessage(event)
        ) {
          // Fire-and-forget: don't block the WebSocket handler
          Promise.resolve(this.onMessage(event)).catch(err => {
            this.log(`Slack message handler error: ${err instanceof Error ? err.message : String(err)}`);
          });
        }
      }

    } catch (error) {
      this.log(`Slack envelope parse error: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * Handle a PERMANENT auth-class failure from apps.connections.open.
   *
   * Latches the fatal state (which also gates scheduleReconnect, so no
   * stray close/watchdog event can restart the loop), tears down any pending
   * reconnect timer, logs a single LOUD operator-facing ERROR line, and fires
   * the onFatalAuthError callback exactly once so the embedding layer
   * (SlackSocketListener / agent-manager) can alert the operator.
   *
   * Recovery: fix the Slack app token, then restart — start() clears the
   * latch and connects fresh.
   */
  private handleFatalAuthError(errorCode: string): void {
    // Latch FIRST: from this point scheduleReconnect() is a no-op.
    this.fatalAuthError = errorCode;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.cleanupWs();
    this.connectionState.onDisconnected();
    this.log(
      `ERROR: Slack Socket Mode PERMANENT auth failure (${errorCode}) — the app token is invalid, revoked, expired, or missing the connections:write scope. ` +
      `Reconnection STOPPED: this will NOT self-heal and real-time Slack inbound is DOWN until the token is fixed and the agent restarts. OPERATOR ACTION REQUIRED.`,
    );
    if (this.onFatalAuthError) {
      try {
        this.onFatalAuthError(errorCode);
      } catch (err) {
        this.log(`Slack fatal-auth alert callback failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  /**
   * Schedule a reconnection attempt with exponential backoff.
   *
   * NEVER gives up permanently. The previous behavior returned once
   * maxReconnectAttempts was reached — but the backoff ladder exhausts in
   * about 3 minutes, so any Slack/network outage longer than that permanently
   * killed real-time inbound until a daemon restart (and while Socket Mode is
   * primary the 60s poll is dormant, so the loss was TOTAL and silent).
   * Past the soft max we keep retrying at the max backoff delay and log the
   * escalation so the condition is visible in the daemon log.
   *
   * ONE exception: a latched PERMANENT auth failure (see handleFatalAuthError)
   * stops the loop — a dead token never self-heals, so retry-forever there
   * would only log-spam while hiding a config error.
   */
  private scheduleReconnect(): void {
    if (this.isShuttingDown) return;
    // Fatal auth latch: a permanent token failure cannot self-heal, so NO path
    // (ws close, open-timeout watchdog, reconnect-error safety net) may
    // re-enter the retry loop until the operator restarts with a fixed token.
    if (this.fatalAuthError) return;

    // Clear any existing reconnect timer to prevent leaks on rapid disconnects
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    // Cap the exponent so Math.pow can't overflow to Infinity on a long outage.
    const cappedExponent = Math.min(this.reconnectAttempts, 16);
    const backoff = Math.min(
      this.baseReconnectDelayMs * Math.pow(2, cappedExponent),
      this.maxReconnectDelayMs,
    );
    // Honor a server-sent Retry-After (set by connect() on HTTP 429) as a
    // one-shot floor on the delay, then clear it.
    const delay = Math.max(backoff, this.rateLimitMinDelayMs);
    this.rateLimitMinDelayMs = 0;
    this.reconnectAttempts++;

    if (this.reconnectAttempts > this.maxReconnectAttempts) {
      this.log(`Slack Socket Mode reconnect attempt ${this.reconnectAttempts} exceeds soft max (${this.maxReconnectAttempts}) — continuing at max backoff (${delay}ms)`);
    } else {
      this.log(`Slack Socket Mode reconnecting in ${delay}ms (attempt ${this.reconnectAttempts}/${this.maxReconnectAttempts})`);
    }
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (!this.isShuttingDown) {
        // connect() catches its own errors; this catch is a final safety net so
        // an unexpected synchronous throw can neither become an unhandled
        // rejection nor silently end the reconnect chain.
        void this.connect().catch((err) => {
          this.log(`Slack Socket Mode reconnect error: ${err instanceof Error ? err.message : String(err)}`);
          this.scheduleReconnect();
        });
      }
    }, delay);
  }
}

// ============================================================================
// Slack Web API Helpers
// ============================================================================

/**
 * Send a message via Slack Web API chat.postMessage.
 * Returns the message timestamp (ts) which serves as Slack's message ID.
 */
export async function postSlackBotMessage(
  botToken: string,
  channel: string,
  text: string,
): Promise<{ ok: boolean; ts?: string; error?: string }> {
  const resp = await fetch('https://slack.com/api/chat.postMessage', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${botToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ channel, text: redactSSN(text) }),
    signal: AbortSignal.timeout(API_TIMEOUT_MS),
  });

  return await resp.json() as { ok: boolean; ts?: string; error?: string };
}

/**
 * Add a reaction to a Slack message (for injection confirmation).
 */
export async function addSlackReaction(
  botToken: string,
  channel: string,
  timestamp: string,
  emoji: string = 'white_check_mark',
): Promise<void> {
  await fetch('https://slack.com/api/reactions.add', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${botToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ channel, timestamp, name: emoji }),
    signal: AbortSignal.timeout(REACTION_TIMEOUT_MS),
  });
}

/**
 * Send a threaded reply in Slack (for injection confirmation).
 */
export async function replySlackThread(
  botToken: string,
  channel: string,
  threadTs: string,
  text: string,
): Promise<void> {
  await fetch('https://slack.com/api/chat.postMessage', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${botToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ channel, text: redactSSN(text), thread_ts: threadTs }),
    signal: AbortSignal.timeout(REACTION_TIMEOUT_MS),
  });
}
