// Slack team-surface P1 (transport swap) — adapter from Socket Mode onto the
// existing inbox-write sink. Produces inbox writes byte-identical in format to
// the legacy checkSlackWatch poll path in fast-checker.ts.

import { SlackSocketClient, type SlackMessageEvent } from '../slack/slack-socket.js';
import { SlackAPI } from '../slack/api.js';
import { sendMessage } from '../bus/message.js';
import {
  resolveSlackIdentity,
  evaluateSlackTrust,
  formatSlackOriginator,
} from '../slack/slack-identity.js';
import { evaluateSlackRoute, type SlackRoutingConfig } from '../slack/slack-routing.js';
import { slackDedupKey } from '../slack/slack-dispatcher.js';
import type { BusPaths, TeamMember } from '../types/index.js';

export interface SlackSocketListenerOptions {
  appToken: string;
  botToken: string;
  channel: string;
  agentName: string;
  paths: BusPaths;
  log: (msg: string) => void;
  signingSecret?: string;
  trustedSlackUsers?: string[];
  teamMembers?: TeamMember[];
  /**
   * Per-agent slack.json routing (D1). When present the listener watches
   * routing.allowed_channels and applies the fail-closed ROUTE GATE
   * (channel + team-scoped composite sender) BEFORE trust enrichment.
   * Absent = legacy single-channel `.env` behavior, byte-for-byte.
   */
  routing?: SlackRoutingConfig;
  /**
   * Invoked once when the Socket Mode client hits a PERMANENT auth failure
   * (invalid/revoked token — reconnection stopped). The daemon wires this to
   * an operator-facing Telegram alert; the listener ALSO writes an urgent
   * agent-inbox message itself, so the condition is surfaced even when the
   * callback is not provided.
   */
  onFatalAuthError?: (errorCode: string) => void;
}

/**
 * Adapts {@link SlackSocketClient} onto the bus inbox-write sink.
 *
 * Each incoming Slack message event is resolved to a display name and written
 * to the agent's inbox via {@link sendMessage} using the EXACT same format,
 * sender ('fast-checker'), recipient (agentName), and priority ('normal') as
 * the legacy poll-based checkSlackWatch path.
 */
export class SlackSocketListener {
  private readonly channel: string;
  private readonly agentName: string;
  private readonly paths: BusPaths;
  private readonly log: (msg: string) => void;
  private readonly slackApi: SlackAPI;
  private readonly client: SlackSocketClient;
  private readonly trustedSlackUsers?: string[];
  private readonly teamMembers?: TeamMember[];
  // D1 routing config (absent = legacy behavior).
  private readonly routing?: SlackRoutingConfig;
  // Workspace team id, resolved alongside the own-bot-user id via auth.test.
  // Needed for the composite team:user route-gate key. null = lookup failed.
  private ownTeamId: string | null | undefined = undefined;
  // Per-listener (event, agent) dedup window for socket redeliveries
  // (reconnect replay, duplicate frames). Bounded FIFO — see recordDelivered.
  private readonly deliveredKeys = new Set<string>();
  private readonly deliveredOrder: string[] = [];
  private static readonly DEDUP_WINDOW_MAX = 500;
  // userId -> resolved identity; populated by resolveSlackIdentity on cache miss
  // so repeat senders never re-hit users.info.
  private readonly identityCache = new Map<
    string,
    { handle: string | null; displayName: string }
  >();
  // Loudly-open warning is logged at most once per listener instance.
  private slackOpenWarned = false;
  // Own bot user id (resolved via auth.test) for the self-echo guard.
  // `undefined` = not yet resolved; `null` = lookup failed (retried after a
  // cooldown — see resolveOwnBotUserId), in which case the own-id check is
  // skipped and shouldDeliverSlackMessage's bot_id guard still applies.
  // A non-null value drops events authored by our own bot.
  private ownBotUserId: string | null | undefined = undefined;
  // In-flight auth.test promise: a burst of inbound messages arriving before
  // the first resolution completes must share ONE lookup, not fan out into N
  // parallel auth.test calls.
  private ownBotUserIdInFlight: Promise<string | null> | null = null;
  // When the lookup failed (null), retry no more than once per cooldown so a
  // transient blip doesn't permanently disable the guard, but a hard outage
  // doesn't add an auth.test call to every message either.
  private ownBotUserIdLastFailureAt = 0;
  private static readonly OWN_ID_RETRY_COOLDOWN_MS = 60_000;
  // Operator-facing alert hook supplied by the daemon (see options doc).
  private readonly onFatalAuthErrorOpt?: (errorCode: string) => void;
  // Persistent fatal-error state: non-null = Slack Socket Mode is DOWN on a
  // permanent auth failure and will NOT self-heal. Queryable via
  // getLastFatalAuthError() so health/heartbeat surfaces can report it.
  private lastFatalAuthError: string | null = null;

  constructor(opts: SlackSocketListenerOptions) {
    this.channel = opts.channel;
    this.agentName = opts.agentName;
    this.paths = opts.paths;
    this.log = opts.log;
    this.trustedSlackUsers = opts.trustedSlackUsers;
    this.teamMembers = opts.teamMembers;
    this.onFatalAuthErrorOpt = opts.onFatalAuthError;
    this.routing = opts.routing;
    this.slackApi = new SlackAPI(opts.botToken);
    this.client = new SlackSocketClient(
      {
        appToken: opts.appToken,
        botToken: opts.botToken,
        channelId: opts.channel,
        // Routing mode watches every allowed channel; legacy mode keeps the
        // single-channel filter untouched.
        channelIds: opts.routing?.allowed_channels,
        signingSecret: opts.signingSecret,
      },
      (event) => this.handleMessage(event),
      opts.log,
      (errorCode) => this.handleFatalAuthError(errorCode),
    );
  }

  /** Start the underlying Socket Mode connection. */
  async start(): Promise<void> {
    // A fresh start gets a fresh slate (mirrors SlackSocketClient.start()
    // clearing its own fatal latch): the operator's recovery path is
    // fix-token-then-restart.
    this.lastFatalAuthError = null;
    await this.client.start();
  }

  /**
   * The permanent auth-failure code that took Slack inbound down, or null.
   * Non-null = Socket Mode reconnection is STOPPED and will not recover
   * without operator action. Exposed for health/heartbeat surfacing.
   */
  getLastFatalAuthError(): string | null {
    return this.lastFatalAuthError;
  }

  /**
   * Surface a PERMANENT Slack auth failure loudly. Called by the socket
   * client exactly once when it stops reconnecting. PUBLIC for unit testing.
   *
   * Three surfaces, so a dead token cannot scroll past unnoticed:
   * 1. persistent lastFatalAuthError state (heartbeat/health queryable);
   * 2. an URGENT agent-inbox message — the agent sees it on its next turn and
   *    relays it to the operator over Telegram;
   * 3. the daemon-level onFatalAuthError callback (agent-manager wires this to
   *    a direct operator Telegram alert, same mechanism as the ALLOWED_USER
   *    reject watchdog).
   *
   * Never throws — a failing alert path must not take anything else down.
   */
  handleFatalAuthError(errorCode: string): void {
    this.lastFatalAuthError = errorCode;
    const inboxText =
      `=== SLACK CONNECTION DEAD (permanent auth failure: ${errorCode}) ===\n` +
      `Slack Socket Mode could not authenticate (channel:${this.channel}) and reconnection has been STOPPED — ` +
      `the app token is invalid, revoked, expired, or missing the connections:write scope. ` +
      `This will NOT self-heal: real-time Slack inbound is DOWN until the token is fixed and the agent restarts.\n` +
      `ACTION REQUIRED: alert the operator NOW (send-telegram), then fix the Slack app token in .env and restart.`;
    try {
      sendMessage(this.paths, 'fast-checker', this.agentName, 'urgent', inboxText);
    } catch (err) {
      this.log('Slack fatal-auth inbox write failed: ' + err);
    }
    if (this.onFatalAuthErrorOpt) {
      try {
        this.onFatalAuthErrorOpt(errorCode);
      } catch (err) {
        this.log('Slack fatal-auth operator alert failed: ' + err);
      }
    }
  }

  /** Gracefully shut down the underlying Socket Mode connection. */
  stop(): void {
    this.client.stop();
  }

  /**
   * Resolve (or re-resolve) the own bot user id with single-flight dedup.
   * getBotUserId never throws (returns null on any failure), so this never
   * throws either. On failure, records the time so the cooldown gate in
   * handleMessage can retry later instead of caching the failure forever.
   */
  private async resolveOwnBotUserId(): Promise<void> {
    if (!this.ownBotUserIdInFlight) {
      // Routing mode needs BOTH identities from one auth.test: own user id
      // (self-echo guard) and team id (route-gate scope). The legacy path
      // keeps calling getBotUserId exactly as before — its runtime surface is
      // part of the byte-for-byte back-compat contract.
      this.ownBotUserIdInFlight = this.routing
        ? this.slackApi.getAuthIdentity().then((identity) => {
            this.ownTeamId = identity?.teamId ?? null;
            return identity?.userId ?? null;
          })
        : this.slackApi.getBotUserId();
    }
    const inFlight = this.ownBotUserIdInFlight;
    const resolved = await inFlight;
    // Only the call that owns the current in-flight promise clears it (a
    // concurrent waiter resuming later must not null out a NEWER lookup).
    if (this.ownBotUserIdInFlight === inFlight) {
      this.ownBotUserIdInFlight = null;
    }
    this.ownBotUserId = resolved;
    if (resolved === null) {
      this.ownBotUserIdLastFailureAt = Date.now();
    }
  }

  /**
   * Keys RESERVED synchronously at the dedup check but not yet durably
   * delivered. Without this, two copies of one envelope arriving close together
   * both pass the `deliveredKeys` membership check before either finishes the
   * awaited identity lookup and records its key — a TOCTOU double delivery. A
   * reservation is released when its handling ends, so a FAILED write still
   * leaves the window clear for a redelivery (spec §2.1c).
   */
  private pendingKeys = new Set<string>();

  /** Bounded FIFO dedup window for (event, agent) keys. */
  private recordDelivered(key: string): void {
    this.deliveredKeys.add(key);
    this.deliveredOrder.push(key);
    while (this.deliveredOrder.length > SlackSocketListener.DEDUP_WINDOW_MAX) {
      const evicted = this.deliveredOrder.shift();
      if (evicted !== undefined) this.deliveredKeys.delete(evicted);
    }
  }

  /**
   * Handle a single Slack message event: resolve the display name and write
   * the formatted message to the agent's inbox. PUBLIC for unit testing.
   *
   * Never throws — inbox-write failures are swallowed and logged, mirroring
   * the legacy poll's try/catch behavior.
   */
  async handleMessage(event: SlackMessageEvent): Promise<void> {
    const userId = event.user;

    // Self-echo guard (belt-and-suspenders alongside shouldDeliverSlackMessage's
    // bot_id drop): never process our own bot user's messages. Resolve the own
    // bot user id via auth.test and cache it on success; failures are retried
    // after a cooldown. If auth.test is unavailable (null), skip this check —
    // the bot_id gate already covers the observed case, and a lookup failure
    // must not kill inbound.
    if (
      this.ownBotUserId === undefined ||
      (this.ownBotUserId === null &&
        Date.now() - this.ownBotUserIdLastFailureAt >= SlackSocketListener.OWN_ID_RETRY_COOLDOWN_MS)
    ) {
      await this.resolveOwnBotUserId();
    }
    if (this.ownBotUserId && userId === this.ownBotUserId) {
      this.log(`Slack message from own bot user ${userId} dropped (self-echo guard)`);
      return;
    }

    // D1 ROUTE GATE (routing mode only): the first of two sequential identity
    // filters — decides IF this agent receives the event at all. Fail-closed on
    // every axis, including an unresolvable team id: a gate that cannot verify
    // the workspace cannot admit.
    let dedupKey: string | null = null;
    if (this.routing) {
      if (!this.ownTeamId) {
        this.log(`Slack route gate: team id unresolved — event ${event.ts} in ${event.channel} DENIED (fail-closed)`);
        return;
      }
      const decision = evaluateSlackRoute(this.routing, {
        teamId: this.ownTeamId,
        channel: event.channel ?? this.channel,
        userId,
      });
      if (!decision.allowed) {
        this.log(`Slack route gate DENIED (${decision.reason}): user ${userId} in ${event.channel ?? this.channel}, event ${event.ts}`);
        return;
      }
      // (event, agent) dedup — socket redeliveries collapse per agent. The key
      // is RESERVED here, synchronously, BEFORE any await: a concurrent second
      // copy of the same envelope must lose this check, not race the identity
      // lookup below (TOCTOU). The reservation is released in the finally.
      const key = slackDedupKey(this.ownTeamId, event.channel ?? this.channel, event.ts, this.agentName);
      if (this.deliveredKeys.has(key) || this.pendingKeys.has(key)) {
        this.log(`Slack event ${event.ts} deduped for ${this.agentName} (already delivered or in flight)`);
        return;
      }
      this.pendingKeys.add(key);
      dedupKey = key;
    }

    try {
      await this.deliverGatedMessage(event, userId, dedupKey);
    } finally {
      // Release the reservation whether delivery succeeded (the durable window
      // now holds the key), was denied by the trust gate, or FAILED (the window
      // stays clear so a redelivery can still land — spec §2.1c).
      if (dedupKey !== null) this.pendingKeys.delete(dedupKey);
    }
  }

  /** Post-gate delivery: identity enrichment, trust gate, durable inbox write.
   * Split from handleMessage so the dedup reservation above has exactly one
   * release point around everything that can await or throw. */
  private async deliverGatedMessage(
    event: SlackMessageEvent,
    userId: string,
    dedupKey: string | null,
  ): Promise<void> {
    const identity = await resolveSlackIdentity(
      userId,
      (id) => this.slackApi.getUserInfo(id),
      this.teamMembers,
      this.identityCache,
    );
    const trust = evaluateSlackTrust(identity.handle, this.trustedSlackUsers);
    if (trust.openWarning && !this.slackOpenWarned) {
      this.log('Slack allowlist not configured — all workspace users can drive the agent.');
      this.slackOpenWarned = true;
    }
    if (!trust.allowed) {
      this.log(`Slack message from untrusted user ${identity.handle ?? userId} dropped (not in allowlist)`);
      return;
    }
    const from = formatSlackOriginator(identity);

    // Coerce text: captionless file/photo shares deliver with no text field,
    // so interpolating event.text directly would render the literal string
    // "undefined" in the inbox body. Match the poll's empty-body behavior.
    const body = event.text ?? '';
    // Routing mode reports the EVENT's channel (multi-channel listener);
    // legacy mode keeps the configured channel — identical output, since the
    // socket filter only passes this.channel there.
    const eventChannel = this.routing ? (event.channel ?? this.channel) : this.channel;
    const inboxText =
      `=== SLACK from ${from} (channel:${eventChannel} ts:${event.ts}) ===\n` +
      `${body}\n` +
      `Reply using: cortextos bus send-slack ${eventChannel} "<reply>"`;

    try {
      sendMessage(this.paths, 'fast-checker', this.agentName, 'normal', inboxText);
      // Mark delivered only AFTER the durable write succeeded, so a thrown
      // write leaves the key clear and a redelivery can still land (spec §2.1c).
      // The key is the SAME reservation taken at the gate — never recomputed.
      if (dedupKey !== null) this.recordDelivered(dedupKey);
    } catch (err) {
      this.log('Slack socket inbox write failed: ' + err);
    }
  }
}
