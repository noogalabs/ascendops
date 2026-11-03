import type { SlackRoutingConfig } from '../slack/slack-routing.js';
import {
  resolveSlackInboundMode,
  type SlackInboundDecision,
} from './slack-inbound-mode.js';

export type SlackReadyInboundDecision = Exclude<SlackInboundDecision, { mode: 'none' }>;

export interface SlackStartupInput {
  configChannel?: string;
  envChannel?: string;
  /** A validated routing file. The caller must reject a malformed existing file. */
  routing: SlackRoutingConfig | null;
  botToken: string;
  appToken: string;
  intervalMs?: number;
  /** Injected so runtime capability failures can be tested without live sockets. */
  webSocketAvailable: boolean;
}

export type SlackStartupDecision =
  | {
      status: 'ready';
      channelSource: 'config' | 'env' | 'routing';
      decision: SlackReadyInboundDecision;
    }
  | { status: 'disabled'; reason: string }
  | { status: 'error'; reason: string };

/**
 * Resolve one agent's inbound startup without reading files or opening sockets.
 *
 * Routing opts into the complete Socket Mode path. Falling back to a poll of
 * just one conversation would silently lose other allowed conversations and
 * bypass the channel-mention behavior. Only a genuinely legacy binding keeps
 * the old polling fallback. Tokens alone never select a conversation.
 */
export function resolveSlackStartup(input: SlackStartupInput): SlackStartupDecision {
  const { routing, webSocketAvailable } = input;
  const configChannel = input.configChannel?.trim();
  const envChannel = input.envChannel?.trim();
  const firstAllowedChannel = routing?.allowed_channels?.find((channel) => channel.trim());

  // Empty/omitted allowlists are a valid deny-all policy, not a request to
  // recover a less restricted legacy binding.
  if (routing !== null) {
    if (!routing.allowed_channels?.length) {
      return { status: 'disabled', reason: 'Slack routing denies all conversations: allowed_channels is empty or omitted' };
    }
    if (!routing.allowed_users?.length) {
      return { status: 'disabled', reason: 'Slack routing denies all senders: allowed_users is empty or omitted' };
    }
  }

  const channel = configChannel || envChannel || firstAllowedChannel?.trim();
  const channelSource = configChannel ? 'config' : envChannel ? 'env' : 'routing';
  if (!channel) {
    return routing === null
      ? { status: 'disabled', reason: 'No Slack conversation configured' }
      : { status: 'error', reason: 'Slack routing has no usable primary conversation' };
  }

  if (routing !== null && !routing.allowed_channels!.includes(channel)) {
    return {
      status: 'error',
      reason: 'The primary Slack conversation must be included in slack.json allowed_channels',
    };
  }

  const botToken = input.botToken.trim();
  const appToken = input.appToken.trim();
  if (routing !== null) {
    if (!botToken) {
      return { status: 'error', reason: 'Routed Slack inbound requires SLACK_BOT_TOKEN' };
    }
    if (!appToken) {
      return { status: 'error', reason: 'Routed Slack inbound requires SLACK_APP_TOKEN for Socket Mode; polling is legacy-only' };
    }
    if (!webSocketAvailable) {
      return {
        status: 'error',
        reason: 'Routed Slack inbound requires native WebSocket support (Node 22+); polling cannot cover routed conversations and mentions',
      };
    }
  }

  const decision = resolveSlackInboundMode({
    botToken,
    appToken,
    channel,
    intervalMs: input.intervalMs ?? 60_000,
    webSocketAvailable,
  });
  if (decision.mode === 'none') {
    return { status: 'disabled', reason: decision.reason };
  }
  return { status: 'ready', channelSource, decision };
}
