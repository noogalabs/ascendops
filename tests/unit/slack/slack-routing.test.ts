import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  evaluateSlackRoute,
  loadSlackRoutingConfig,
  composeSenderKey,
  slackConfigPath,
  SlackRoutingConfigError,
  type SlackRoutingConfig,
} from '../../../src/slack/slack-routing';

// PAIRED POLARITY throughout: every gate is tested in BOTH directions. A gate
// that only ever denies is indistinguishable from a gate that denies
// everything, so each must-die case carries a matched must-pass control.

const EVENT = { teamId: 'T01', channel: 'C123', userId: 'U01' };
const OPEN: SlackRoutingConfig = {
  allowed_channels: ['C123'],
  allowed_users: ['T01:U01'],
};

describe('evaluateSlackRoute — fail-closed route gate', () => {
  it('POSITIVE control: an allowed channel + allowed composite sender passes', () => {
    expect(evaluateSlackRoute(OPEN, EVENT)).toEqual({ allowed: true });
  });

  it('denies when there is no config at all (absent slack.json is not an open door)', () => {
    expect(evaluateSlackRoute(null, EVENT)).toEqual({ allowed: false, reason: 'no-config' });
  });

  it('denies an unlisted channel, and the matched control still passes', () => {
    expect(evaluateSlackRoute(OPEN, { ...EVENT, channel: 'C999' }))
      .toEqual({ allowed: false, reason: 'channel-not-allowed' });
    expect(evaluateSlackRoute(OPEN, EVENT).allowed).toBe(true);
  });

  it('denies an unlisted user even in an allowed channel (membership is not authority)', () => {
    expect(evaluateSlackRoute(OPEN, { ...EVENT, userId: 'U99' }))
      .toEqual({ allowed: false, reason: 'user-not-allowed' });
    expect(evaluateSlackRoute(OPEN, EVENT).allowed).toBe(true);
  });

  it('denies a same-user-id sender from a DIFFERENT workspace (team scoping is real)', () => {
    expect(evaluateSlackRoute(OPEN, { ...EVENT, teamId: 'T99' }))
      .toEqual({ allowed: false, reason: 'user-not-allowed' });
  });

  it('empty and absent lists both deny (fail-closed, not fail-open)', () => {
    expect(evaluateSlackRoute({ allowed_channels: [], allowed_users: [] }, EVENT).allowed).toBe(false);
    expect(evaluateSlackRoute({}, EVENT).allowed).toBe(false);
    expect(evaluateSlackRoute({ allowed_channels: ['C123'] }, EVENT))
      .toEqual({ allowed: false, reason: 'user-not-allowed' });
  });

  it('composeSenderKey is team-scoped', () => {
    expect(composeSenderKey('T01', 'U01')).toBe('T01:U01');
  });
});

describe('loadSlackRoutingConfig', () => {
  let root: string;
  const agentDir = (r: string) => join(r, 'orgs', 'acme', 'agents', 'alpha');

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'slack-routing-'));
    mkdirSync(agentDir(root), { recursive: true });
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('resolves the documented path', () => {
    expect(slackConfigPath(root, 'acme', 'alpha')).toBe(join(agentDir(root), 'slack.json'));
  });

  it('loads a valid config, and the loaded config actually routes (end-to-end control)', () => {
    writeFileSync(join(agentDir(root), 'slack.json'), JSON.stringify(OPEN));
    const loaded = loadSlackRoutingConfig(root, 'acme', 'alpha');
    expect(loaded?.allowed_channels).toEqual(['C123']);
    expect(evaluateSlackRoute(loaded, EVENT).allowed).toBe(true);
  });

  it('BACK-COMPAT: absent config returns null, which the gate treats as ungated-by-this-module', () => {
    // null here means "this agent has no routing config" — the daemon keeps its
    // existing .env-driven 1:1 binding. The gate itself denies null, so routing
    // can never silently open; the CALLER decides which path an agent is on.
    expect(loadSlackRoutingConfig(root, 'acme', 'alpha')).toBeNull();
  });

  it('defaults channel mention gating on for a present config, and preserves an explicit opt-out', () => {
    writeFileSync(join(agentDir(root), 'slack.json'), JSON.stringify(OPEN));
    expect(loadSlackRoutingConfig(root, 'acme', 'alpha')?.channel_mentions_only).toBe(true);
    writeFileSync(join(agentDir(root), 'slack.json'), JSON.stringify({ ...OPEN, channel_mentions_only: false }));
    expect(loadSlackRoutingConfig(root, 'acme', 'alpha')?.channel_mentions_only).toBe(false);
  });

  it('rejects a non-boolean channel_mentions_only instead of treating truthy text as a policy', () => {
    writeFileSync(join(agentDir(root), 'slack.json'), JSON.stringify({ ...OPEN, channel_mentions_only: 'false' }));
    expect(() => loadSlackRoutingConfig(root, 'acme', 'alpha')).toThrow(/invalid-shape/);
  });

  it('throws for an existing config path that cannot be read as a file', () => {
    mkdirSync(join(agentDir(root), 'slack.json'));
    expect(() => loadSlackRoutingConfig(root, 'acme', 'alpha')).toThrow(/unreadable.*refusing legacy fallback/);
  });

  it.skipIf(process.platform === 'win32')('a dangling config symlink is invalid rather than absent', () => {
    symlinkSync(join(root, 'missing-target.json'), join(agentDir(root), 'slack.json'));
    expect(() => loadSlackRoutingConfig(root, 'acme', 'alpha')).toThrow(/unreadable.*refusing legacy fallback/);
  });

  it('malformed JSON throws rather than selecting the less restrictive legacy route', () => {
    writeFileSync(join(agentDir(root), 'slack.json'), '{ not json');
    expect(() => loadSlackRoutingConfig(root, 'acme', 'alpha')).toThrow(SlackRoutingConfigError);
    expect(() => loadSlackRoutingConfig(root, 'acme', 'alpha')).toThrow(/invalid-json.*refusing legacy fallback/);
  });

  it('does not copy malformed file contents into the reported error', () => {
    writeFileSync(join(agentDir(root), 'slack.json'), '{"value":"PRIVATE_SENTINEL"');
    try {
      loadSlackRoutingConfig(root, 'acme', 'alpha');
      expect.fail('Malformed routing should throw');
    } catch (error) {
      expect(error).toBeInstanceOf(SlackRoutingConfigError);
      expect((error as SlackRoutingConfigError).code).toBe('SLACK_ROUTING_CONFIG_INVALID');
      expect((error as Error).message).not.toContain('PRIVATE_SENTINEL');
    }
  });

  it('a JSON array or scalar is rejected as malformed, not coerced', () => {
    writeFileSync(join(agentDir(root), 'slack.json'), '["C123"]');
    expect(() => loadSlackRoutingConfig(root, 'acme', 'alpha')).toThrow(/invalid-shape/);
    writeFileSync(join(agentDir(root), 'slack.json'), '42');
    expect(() => loadSlackRoutingConfig(root, 'acme', 'alpha')).toThrow(/invalid-shape/);
  });

  // SHAPE VALIDATION (PR313 Codex P1): a syntactically valid JSON object whose
  // fields have the wrong type must be MALFORMED at load, never a TypeError at
  // event time inside a consumer. The exact reported repro is the first case.
  it('non-array allowed_channels/allowed_users are rejected as malformed (reported repro)', () => {
    writeFileSync(
      join(agentDir(root), 'slack.json'),
      JSON.stringify({ allowed_channels: {}, allowed_users: {} }),
    );
    expect(() => loadSlackRoutingConfig(root, 'acme', 'alpha')).toThrow(/invalid-shape/);
    writeFileSync(
      join(agentDir(root), 'slack.json'),
      JSON.stringify({ allowed_channels: 'C123', allowed_users: ['T01:U01'] }),
    );
    expect(() => loadSlackRoutingConfig(root, 'acme', 'alpha')).toThrow(/invalid-shape/);
  });

  it('arrays with non-string members are rejected as malformed', () => {
    writeFileSync(
      join(agentDir(root), 'slack.json'),
      JSON.stringify({ allowed_channels: ['C123', 42], allowed_users: ['T01:U01'] }),
    );
    expect(() => loadSlackRoutingConfig(root, 'acme', 'alpha')).toThrow(/invalid-shape/);
  });

  it('non-string display fields and non-array allowlists are rejected as malformed', () => {
    writeFileSync(
      join(agentDir(root), 'slack.json'),
      JSON.stringify({ allowed_channels: 'C123' }),
    );
    expect(() => loadSlackRoutingConfig(root, 'acme', 'alpha')).toThrow(/invalid-shape/);
    writeFileSync(
      join(agentDir(root), 'slack.json'),
      JSON.stringify({ display_name: 7, allowed_channels: ['C123'] }),
    );
    expect(() => loadSlackRoutingConfig(root, 'acme', 'alpha')).toThrow(/invalid-shape/);
  });

  it('POLARITY CONTROL: a fully-populated valid config still loads and routes', () => {
    writeFileSync(
      join(agentDir(root), 'slack.json'),
      JSON.stringify({
        display_name: 'alpha',
        icon_emoji: ':dog:',
        allowed_channels: ['C123'],
        allowed_users: ['T01:U01'],
      }),
    );
    const loaded = loadSlackRoutingConfig(root, 'acme', 'alpha');
    expect(loaded).not.toBeNull();
    expect(evaluateSlackRoute(loaded, EVENT).allowed).toBe(true);
  });
});

// PR313 Codex P1 (shared-app topology): Slack splits an app's envelopes across
// its open connections, so agent-manager must DETECT two agents claiming one
// app token. The registry is pure; the loud warning is wired in agent-manager.
describe('claimSlackAppToken / releaseSlackAppTokens', () => {
  it('first claim succeeds; a second agent on the SAME token is reported as a conflict', async () => {
    const { claimSlackAppToken } = await import('../../../src/slack/slack-routing');
    const owners = new Map<string, string>();
    expect(claimSlackAppToken(owners, 'xapp-1', 'alpha')).toBeNull();
    expect(claimSlackAppToken(owners, 'xapp-1', 'beta')).toBe('alpha');
  });

  it('re-claim by the same agent (restart) is a no-op success, and distinct tokens never conflict', async () => {
    const { claimSlackAppToken } = await import('../../../src/slack/slack-routing');
    const owners = new Map<string, string>();
    expect(claimSlackAppToken(owners, 'xapp-1', 'alpha')).toBeNull();
    expect(claimSlackAppToken(owners, 'xapp-1', 'alpha')).toBeNull();
    expect(claimSlackAppToken(owners, 'xapp-2', 'beta')).toBeNull();
  });

  it('release frees the token so a reassigned agent can claim it cleanly', async () => {
    const { claimSlackAppToken, releaseSlackAppTokens } = await import('../../../src/slack/slack-routing');
    const owners = new Map<string, string>();
    claimSlackAppToken(owners, 'xapp-1', 'alpha');
    releaseSlackAppTokens(owners, 'alpha');
    expect(claimSlackAppToken(owners, 'xapp-1', 'beta')).toBeNull();
  });
});
