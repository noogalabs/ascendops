import { describe, it, expect } from 'vitest';
import { slackDedupKey } from '../../../src/slack/slack-dispatcher';

// N:1 fan-out happens through PER-AGENT apps and listeners (see the module
// docstring); what this file pins is the shared dedup IDENTITY those listeners
// use. The fan-out-collapse casualty lives at the key: if the key ever stopped
// including the agent, the first agent's delivery would suppress every other
// agent's copy of the same event.
describe('slackDedupKey — per (event, agent) identity', () => {
  it('casualty: fan-out-collapse — two agents produce DIFFERENT keys for one event', () => {
    const a = slackDedupKey('T01', 'C123', '1700000000.000100', 'alpha');
    const b = slackDedupKey('T01', 'C123', '1700000000.000100', 'beta');
    expect(a).not.toBe(b);
  });

  it('a redelivery (same event, same agent) produces the SAME key — the collapse case', () => {
    const first = slackDedupKey('T01', 'C123', '1700000000.000100', 'alpha');
    const replay = slackDedupKey('T01', 'C123', '1700000000.000100', 'alpha');
    expect(first).toBe(replay);
  });

  it('distinct events (ts), channels, and teams all produce distinct keys', () => {
    const base = slackDedupKey('T01', 'C123', '1700000000.000100', 'alpha');
    expect(slackDedupKey('T01', 'C123', '1700000000.000200', 'alpha')).not.toBe(base);
    expect(slackDedupKey('T01', 'C999', '1700000000.000100', 'alpha')).not.toBe(base);
    expect(slackDedupKey('T02', 'C123', '1700000000.000100', 'alpha')).not.toBe(base);
  });

  it('key shape is the documented spec §2.1a format', () => {
    expect(slackDedupKey('T01', 'C123', '1700000000.000100', 'alpha')).toBe(
      'slack:T01:C123:1700000000.000100:alpha',
    );
  });
});
