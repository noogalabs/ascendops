/**
 * Per-agent Slack routing config + the fail-closed ROUTE GATE.
 *
 * This is the first of two sequential identity filters (see
 * docs/architecture/slack-reconciliation-spec.md §1):
 *
 *   1. ROUTE GATE (this module) — decides IF an agent receives an event at all,
 *      from that agent's own `slack.json`. Fail-closed: missing/empty lists
 *      deny. Adapted from upstream 8475381d's per-agent gating model.
 *   2. TRUST ENRICHMENT (`slack-identity.ts`) — decides WHAT IS KNOWN about the
 *      sender, resolved server-side from team_members. Never replaced by this
 *      gate, and never read from caller-supplied text.
 *
 * BACK-COMPAT (load-bearing): an agent with no `slack.json` is NOT gated by
 * this module at all — it keeps the existing `.env`-driven 1:1 channel binding
 * byte-for-byte. Adding routing is opt-in; no agent is forced to migrate.
 */
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';

/** Schema of `orgs/<org>/agents/<name>/slack.json`. Non-secret: tokens stay in .env. */
export interface SlackRoutingConfig {
  /** Outbound display identity. VALUES GATED — see spec §4: plain functional
   * name only until the brand/persona review clears custom values. */
  display_name?: string;
  icon_emoji?: string;
  icon_url?: string;
  /** Channel ids this agent may RECEIVE from. Empty/absent denies all. */
  allowed_channels?: string[];
  /** `"<team_id>:<user_id>"` composite senders allowed. Empty/absent denies all. */
  allowed_users?: string[];
}

export interface SlackRouteEvent {
  teamId: string;
  channel: string;
  userId: string;
}

export type RouteDenyReason = 'no-config' | 'channel-not-allowed' | 'user-not-allowed';

export type RouteDecision =
  | { allowed: true }
  | { allowed: false; reason: RouteDenyReason };

/** Resolve an agent's config path. Mirrors the daemon's agent-dir convention. */
export function slackConfigPath(frameworkRoot: string, org: string, agentName: string): string {
  return join(frameworkRoot, 'orgs', org, 'agents', agentName, 'slack.json');
}

function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((x) => typeof x === 'string');
}

function isOptionalString(v: unknown): boolean {
  return v === undefined || typeof v === 'string';
}

/**
 * Shape-validate a parsed slack.json value. Every field the gate or the
 * display path will touch is checked here so a hand-authored file like
 * `{"allowed_channels": {}}` is rejected as MALFORMED at load time instead of
 * throwing `.includes is not a function` inside a consumer at event time.
 */
export function isValidSlackRoutingShape(parsed: unknown): parsed is SlackRoutingConfig {
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return false;
  const cfg = parsed as Record<string, unknown>;
  if (!isOptionalString(cfg.display_name)) return false;
  if (!isOptionalString(cfg.icon_emoji)) return false;
  if (!isOptionalString(cfg.icon_url)) return false;
  if (cfg.allowed_channels !== undefined && !isStringArray(cfg.allowed_channels)) return false;
  if (cfg.allowed_users !== undefined && !isStringArray(cfg.allowed_users)) return false;
  return true;
}

/**
 * Load `slack.json` for one agent, or null when absent/unreadable/malformed.
 *
 * Malformed includes SHAPE-invalid, not just unparseable: any file this
 * function returns is safe for every consumer to use without type checks. A
 * malformed file returns null rather than throwing: a broken config must not
 * take the daemon down. It is indistinguishable from absent HERE, but callers
 * that care (the loader in agent-manager) log the failure loudly so a typo
 * does not silently disable routing.
 */
export function loadSlackRoutingConfig(
  frameworkRoot: string,
  org: string,
  agentName: string,
): SlackRoutingConfig | null {
  const path = slackConfigPath(frameworkRoot, org, agentName);
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf-8')) as unknown;
    return isValidSlackRoutingShape(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Claim a Socket Mode app token for one agent's listener.
 *
 * Slack distributes event envelopes ACROSS an app's open connections — each
 * event goes to ONE of them. Two agents opening Socket Mode with the SAME app
 * therefore each receive a random subset of events: silent per-agent message
 * loss, not fan-out. The supported N:1 topology is one Slack app PER AGENT
 * (see the runbook §1). This registry lets the daemon detect the unsupported
 * shape and warn loudly.
 *
 * Returns the name of the agent already holding the token (a CONFLICT), or
 * null when the claim succeeds. Re-claiming by the same agent is a no-op
 * success (agent restarts).
 */
export function claimSlackAppToken(
  owners: Map<string, string>,
  appToken: string,
  agentName: string,
): string | null {
  const existing = owners.get(appToken);
  if (existing !== undefined && existing !== agentName) return existing;
  owners.set(appToken, agentName);
  return null;
}

/** Release every token held by an agent (called when its listener stops). */
export function releaseSlackAppTokens(owners: Map<string, string>, agentName: string): void {
  for (const [token, owner] of owners) {
    if (owner === agentName) owners.delete(token);
  }
}

declare const personaGateApproved: unique symbol;

/**
 * Display identity that has PASSED the D4 persona gate. The brand makes this
 * type constructible ONLY by gateSlackDisplayIdentity below (the single cast
 * site) — SlackAPI.postMessage accepts nothing else, so an ungated slack.json
 * value structurally cannot reach a payload. Icons are not expressible here at
 * all: no icon value is persona-review approved, so the payload primitive has
 * no field to carry one.
 */
export interface GatedDisplayIdentity {
  readonly [personaGateApproved]: true;
  /** Always the agent's plain functional name until persona-review authority exists. */
  readonly username: string;
}

/**
 * D4 PERSONA GATE — structural enforcement on the production path (PR313
 * heavy-seat RED: a gate that lives only in spec prose is a log line, not a
 * gate). Until the brand/persona review exists as an authority:
 *
 *  - `display_name` is permitted ONLY when it equals the agent's functional
 *    name. Any other value is LOUDLY suppressed and the functional name is
 *    sent in its place — a hand-edited slack.json cannot ship a persona. When
 *    `display_name` is OMITTED (a routing-only config), the functional name is
 *    still sent, so an ordinary config is never misattributed to the app default.
 *  - `icon_emoji` / `icon_url` are never forwarded (no approved values exist);
 *    their presence is loudly logged.
 */
export function gateSlackDisplayIdentity(
  config: SlackRoutingConfig | null,
  agentName: string,
  log: (line: string) => void = () => {},
): GatedDisplayIdentity | undefined {
  if (config === null) return undefined;
  if (config.icon_emoji !== undefined || config.icon_url !== undefined) {
    log(
      `PERSONA GATE: icon_emoji/icon_url in slack.json SUPPRESSED for '${agentName}' — no icon values are persona-review approved; icons are never sent.`,
    );
  }
  // A valid slack.json (routing-only or otherwise) always posts under the agent's
  // functional name — the agent-name-only invariant holds even when display_name
  // is omitted, so an ordinary routing config is never misattributed to the
  // app's default identity. Only an ABSENT slack.json (config === null, handled
  // above) keeps the back-compat no-override default.
  if (config.display_name !== undefined && config.display_name !== agentName) {
    log(
      `PERSONA GATE: display_name '${config.display_name}' SUPPRESSED for '${agentName}' — not persona-review approved. Sending the plain functional name '${agentName}' instead.`,
    );
  }
  return { username: agentName } as GatedDisplayIdentity;
}

/**
 * Production resolver: slack.json on disk → gated identity. The CLI send
 * paths call this; the persona-gate casualties bind this same entry, so the
 * tested path IS the shipping path.
 */
export function resolveGatedDisplayIdentity(
  frameworkRoot: string,
  org: string,
  agentName: string,
  log: (line: string) => void = () => {},
): GatedDisplayIdentity | undefined {
  return gateSlackDisplayIdentity(loadSlackRoutingConfig(frameworkRoot, org, agentName), agentName, log);
}

/** Composite sender identity: team-scoped, so a user id from another workspace
 * can never satisfy this workspace's allowlist. */
export function composeSenderKey(teamId: string, userId: string): string {
  return `${teamId}:${userId}`;
}

/**
 * THE ROUTE GATE. Fail-closed on every axis.
 *
 * Both gates must pass: the event's channel must be in `allowed_channels`, AND
 * the composite `team:user` must be in `allowed_users`. Channel membership
 * alone is never sufficient — anyone in a shared channel would otherwise be
 * able to drive an agent.
 */
export function evaluateSlackRoute(
  config: SlackRoutingConfig | null,
  event: SlackRouteEvent,
): RouteDecision {
  if (config === null) return { allowed: false, reason: 'no-config' };

  const channels = config.allowed_channels ?? [];
  if (!channels.includes(event.channel)) {
    return { allowed: false, reason: 'channel-not-allowed' };
  }

  const users = config.allowed_users ?? [];
  if (!users.includes(composeSenderKey(event.teamId, event.userId))) {
    return { allowed: false, reason: 'user-not-allowed' };
  }

  return { allowed: true };
}
