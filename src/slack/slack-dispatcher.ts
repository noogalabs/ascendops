/**
 * Shared dedup identity for Slack inbound delivery.
 *
 * TOPOLOGY (corrected in PR313 review): N:1 — one channel feeding many agents —
 * is achieved by PER-AGENT Slack apps. Each agent runs its own app with its own
 * tokens; each app subscribed to a channel receives its OWN full copy of that
 * channel's events, so every agent's listener gates and delivers independently.
 * There is no shared connection and therefore no central fan-out dispatcher:
 * Slack distributes envelopes ACROSS an app's open Socket Mode connections
 * (each event goes to ONE of them), so a single app shared by several agents
 * would split events between them at random — that topology is unsupported and
 * agent-manager warns loudly when it detects it (see claimSlackAppToken in
 * slack-routing.ts).
 *
 * What IS shared across consumers is the dedup identity below:
 *
 *   (a) DEDUP IDENTITY IS PER (EVENT, AGENT). The key includes the agent name,
 *       so one agent's delivery can never suppress another's copy of the same
 *       event — the per-agent windows collapse only socket REDELIVERIES
 *       (reconnect replays, duplicate frames), never fan-out.
 *   (b) ACKS ARE INDEPENDENT by construction: each delivery is its own durable
 *       inbox message with its own id, acked by its own agent.
 *   (c) PARTIAL FAILURE IS PER-AGENT AND LOUD: each listener logs its own
 *       failed write and leaves its own window clear for a redelivery; other
 *       agents' deliveries are separate writes and cannot be affected.
 */

/**
 * Dedup key for one (event, agent) pair.
 *
 * `event_ts` is Slack's stable per-message identifier, so a socket redelivery
 * (reconnect replay, duplicate frame) collapses per agent. The agent name is
 * part of the key on purpose — see (a) above.
 */
export function slackDedupKey(
  teamId: string,
  channel: string,
  eventTs: string,
  agentName: string,
): string {
  return `slack:${teamId}:${channel}:${eventTs}:${agentName}`;
}
