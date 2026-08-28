import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { SlackAPI } from '../../../src/slack/api';

let responses: Array<{ status: number; body: any }> = [];
let calls: string[] = [];

beforeEach(() => {
  responses = [];
  calls = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    calls.push(String(url));
    const next = responses.shift();
    if (!next) throw new Error('no queued response');
    return {
      ok: next.status === 200,
      status: next.status,
      json: async () => next.body,
      text: async () => JSON.stringify(next.body),
    } as Response;
  }));
});
afterEach(() => vi.unstubAllGlobals());

describe('SlackAPI.listChannels', () => {
  it('filters to member channels by default and follows pagination', async () => {
    responses.push({ status: 200, body: {
      ok: true,
      channels: [
        { id: 'C1', name: 'ops', is_member: true },
        { id: 'C2', name: 'random', is_member: false },
      ],
      response_metadata: { next_cursor: 'abc' },
    }});
    responses.push({ status: 200, body: {
      ok: true,
      channels: [{ id: 'C3', name: 'approvals', is_member: true }],
      response_metadata: { next_cursor: '' },
    }});
    const list = await new SlackAPI('xoxb-test').listChannels();
    expect(list).toEqual([
      { id: 'C1', name: 'ops', isMember: true },
      { id: 'C3', name: 'approvals', isMember: true },
    ]);
    expect(calls).toHaveLength(2);
    expect(calls[1]).toContain('cursor=abc');
  });

  it('includes non-member channels with --all semantics (memberOnly=false)', async () => {
    responses.push({ status: 200, body: {
      ok: true,
      channels: [{ id: 'C2', name: 'random', is_member: false }],
      response_metadata: { next_cursor: '' },
    }});
    const list = await new SlackAPI('xoxb-test').listChannels(false);
    expect(list).toEqual([{ id: 'C2', name: 'random', isMember: false }]);
  });

  it('surfaces a Slack API error instead of returning a partial list', async () => {
    responses.push({ status: 200, body: { ok: false, error: 'invalid_auth' } });
    await expect(new SlackAPI('xoxb-bad').listChannels()).rejects.toThrow('invalid_auth');
  });
});

describe('SlackAPI.postMessage display identity (D4, persona-gated)', () => {
  it('omits identity fields entirely when no identity is passed (plain default)', async () => {
    responses.push({ status: 200, body: { ok: true } });
    let sent: any;
    (fetch as any).mockImplementationOnce(async (url: string, init: RequestInit) => {
      sent = JSON.parse(String(init.body));
      return { ok: true, status: 200, json: async () => ({ ok: true }), text: async () => '{}' } as Response;
    });
    await new SlackAPI('xoxb-test').postMessage('C1', 'hello');
    expect(sent.username).toBeUndefined();
    expect(sent.icon_emoji).toBeUndefined();
    expect(sent.icon_url).toBeUndefined();
  });

  it('STRUCTURAL: postMessage rejects an ungated identity object at the type level', async () => {
    responses.push({ status: 200, body: { ok: true } });
    const api = new SlackAPI('xoxb-test');
    // The identity parameter is the branded GatedDisplayIdentity — a raw
    // object literal (what the pre-gate code accepted) must not compile. If
    // the gate type ever loosens, this line turns into an "unused directive"
    // tsc error and the suite goes red.
    // @ts-expect-error ungated identity cannot be passed to the payload primitive
    await api.postMessage('C1', 'hello', { username: 'Fancy Persona', iconEmoji: ':dog:' });
  });
});
