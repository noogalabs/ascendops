import { describe, expect, it } from 'vitest';
import {
  resolveSlackStartup,
  type SlackStartupInput,
} from '../../../src/daemon/slack-startup.js';

const routed: SlackStartupInput = {
  routing: {
    allowed_channels: ['D_PILOT', 'C_STATUS'],
    allowed_users: ['T_EXAMPLE:U_MEMBER'],
  },
  botToken: 'test-bot-token',
  appToken: 'test-app-token',
  webSocketAvailable: true,
};

describe('resolveSlackStartup', () => {
  it('starts a DM-only route directly from its allowed conversation without a synthetic channel', () => {
    expect(resolveSlackStartup({
      ...routed,
      routing: { allowed_channels: ['D_PILOT'], allowed_users: ['T_EXAMPLE:U_MEMBER'] },
    })).toEqual({
      status: 'ready',
      channelSource: 'routing',
      decision: {
        mode: 'socket',
        channel: 'D_PILOT',
        botToken: 'test-bot-token',
        appToken: 'test-app-token',
      },
    });
  });

  it('gives an explicit config channel precedence over the environment and route order', () => {
    const result = resolveSlackStartup({ ...routed, configChannel: 'C_STATUS', envChannel: 'D_PILOT' });
    expect(result).toMatchObject({ status: 'ready', channelSource: 'config', decision: { channel: 'C_STATUS' } });
  });

  it('uses an environment conversation when the config channel is absent or blank', () => {
    const result = resolveSlackStartup({ ...routed, configChannel: '  ', envChannel: ' C_STATUS ' });
    expect(result).toMatchObject({ status: 'ready', channelSource: 'env', decision: { channel: 'C_STATUS' } });
  });

  it('rejects an explicitly selected conversation outside the route instead of choosing another one', () => {
    const result = resolveSlackStartup({ ...routed, configChannel: 'C_UNAPPROVED', envChannel: 'D_PILOT' });
    expect(result).toEqual({
      status: 'error',
      reason: 'The primary Slack conversation must be included in slack.json allowed_channels',
    });
  });

  it('also rejects an environment conversation outside the route', () => {
    expect(resolveSlackStartup({ ...routed, envChannel: 'C_UNAPPROVED' }).status).toBe('error');
  });

  it.each([
    { allowed_channels: [], allowed_users: ['T_EXAMPLE:U_MEMBER'] },
    { allowed_users: ['T_EXAMPLE:U_MEMBER'] },
  ])('keeps a denied-all conversation policy disabled without legacy recovery: %j', (routing) => {
    const result = resolveSlackStartup({ ...routed, routing, configChannel: 'C_STATUS' });
    expect(result).toMatchObject({ status: 'disabled', reason: expect.stringContaining('denies all conversations') });
  });

  it.each([
    { allowed_channels: ['D_PILOT'], allowed_users: [] },
    { allowed_channels: ['D_PILOT'] },
  ])('keeps a denied-all sender policy disabled without legacy recovery: %j', (routing) => {
    const result = resolveSlackStartup({ ...routed, routing });
    expect(result).toMatchObject({ status: 'disabled', reason: expect.stringContaining('denies all senders') });
  });

  it('does not silently poll a routed multi-conversation setup without native WebSocket', () => {
    const result = resolveSlackStartup({ ...routed, webSocketAvailable: false });
    expect(result).toMatchObject({ status: 'error', reason: expect.stringContaining('native WebSocket') });
  });

  it('requires Socket Mode even for a single routed DM so later routes cannot silently be missed', () => {
    const result = resolveSlackStartup({
      ...routed,
      routing: { allowed_channels: ['D_PILOT'], allowed_users: ['T_EXAMPLE:U_MEMBER'] },
      appToken: '',
    });
    expect(result).toMatchObject({ status: 'error', reason: expect.stringContaining('SLACK_APP_TOKEN') });
  });

  it('reports a missing bot token as a routed configuration error', () => {
    expect(resolveSlackStartup({ ...routed, botToken: ' ' })).toEqual({
      status: 'error', reason: 'Routed Slack inbound requires SLACK_BOT_TOKEN',
    });
  });

  it('does not activate ingress from credentials alone in legacy mode', () => {
    expect(resolveSlackStartup({ ...routed, routing: null })).toEqual({
      status: 'disabled', reason: 'No Slack conversation configured',
    });
  });

  it('preserves bot-only polling for a truly legacy single binding', () => {
    expect(resolveSlackStartup({
      ...routed, routing: null, configChannel: 'C_LEGACY', appToken: '', intervalMs: 30_000,
    })).toEqual({
      status: 'ready',
      channelSource: 'config',
      decision: { mode: 'poll', channel: 'C_LEGACY', botToken: 'test-bot-token', intervalMs: 30_000 },
    });
  });

  it('retains a loud legacy polling fallback when Socket Mode is unavailable', () => {
    const result = resolveSlackStartup({
      ...routed, routing: null, envChannel: 'C_LEGACY', webSocketAvailable: false,
    });
    expect(result).toMatchObject({
      status: 'ready', channelSource: 'env',
      decision: { mode: 'poll', channel: 'C_LEGACY', intervalMs: 60_000, reason: expect.stringContaining('WebSocket') },
    });
  });

  it('keeps a configured legacy binding inactive when no bot credential is available', () => {
    expect(resolveSlackStartup({ ...routed, routing: null, configChannel: 'C_LEGACY', botToken: '' })).toEqual({
      status: 'disabled', reason: 'SLACK_BOT_TOKEN not found',
    });
  });

  it('does not normalize a malformed allowed ID into a different accepted route', () => {
    const result = resolveSlackStartup({
      ...routed, routing: { allowed_channels: [' D_PILOT '], allowed_users: ['T_EXAMPLE:U_MEMBER'] },
    });
    expect(result.status).toBe('error');
  });

  it('reports a route with only blank conversation values instead of starting an empty listener', () => {
    expect(resolveSlackStartup({
      ...routed, routing: { allowed_channels: ['  '], allowed_users: ['T_EXAMPLE:U_MEMBER'] },
    })).toEqual({ status: 'error', reason: 'Slack routing has no usable primary conversation' });
  });
});
