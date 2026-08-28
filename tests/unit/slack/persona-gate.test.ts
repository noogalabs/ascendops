import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { resolveGatedDisplayIdentity, gateSlackDisplayIdentity } from '../../../src/slack/slack-routing';

/**
 * D4 PERSONA GATE casualties — three review rounds deep, all proven at the
 * captured chat.postMessage payload:
 *
 *  - round 1 (config path): slack.json values cannot ship a persona;
 *  - round 2 (crafted callers): the compile-time brand is erased at runtime,
 *    so `as any` identities are suppressed at the primitive;
 *  - round 3 (authority forgery): the emitted username comes ONLY from the
 *    module-private RUNTIME_AGENT_NAME captured at module load from
 *    CTX_AGENT_NAME — the four seat bypasses (mint, second construction,
 *    prototype inheritance, post-construction mutation) must all emit the
 *    functional name, because there is no longer anything to forge.
 *
 * SlackAPI captures the agent context AT MODULE LOAD, so every test imports a
 * FRESH copy of the module after setting CTX_AGENT_NAME (vi.resetModules).
 */

const AGENT = 'alpha';
let root: string;
let sentBodies: any[] = [];
let logs: string[] = [];
let errSpy: ReturnType<typeof vi.spyOn>;
const savedAgentName = process.env.CTX_AGENT_NAME;
const agentDir = () => join(root, 'orgs', 'acme', 'agents', AGENT);
const log = (line: string) => logs.push(line);

/** Fresh SlackAPI module with the captured agent context set to `name`
 * (or captured EMPTY when name is undefined). */
async function freshSlackAPI(name: string | undefined): Promise<any> {
  vi.resetModules();
  if (name === undefined) delete process.env.CTX_AGENT_NAME;
  else process.env.CTX_AGENT_NAME = name;
  const mod = await import('../../../src/slack/api');
  return mod.SlackAPI;
}

function writeSlackJson(cfg: object): void {
  writeFileSync(join(agentDir(), 'slack.json'), JSON.stringify(cfg));
}

/** The production sequence under test: resolve (gate) then post. */
async function resolveAndPost(): Promise<any> {
  const SlackAPI = await freshSlackAPI(AGENT);
  const identity = resolveGatedDisplayIdentity(root, 'acme', AGENT, log);
  await new SlackAPI('xoxb-test').postMessage('C1', 'hello', identity);
  return sentBodies[sentBodies.length - 1];
}

/** Runtime warnings go to console.error (the module has no injectable log —
 * an injectable sink was part of the forgeable round-2 authority object). */
function runtimeWarnings(): string[] {
  return errSpy.mock.calls.map((c) => String(c[0])).filter((l) => l.includes('PERSONA GATE (runtime)'));
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'persona-gate-'));
  mkdirSync(agentDir(), { recursive: true });
  sentBodies = [];
  logs = [];
  errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
    sentBodies.push(JSON.parse(String(init.body)));
    return {
      ok: true,
      status: 200,
      json: async () => ({ ok: true }),
      text: async () => '{}',
    } as Response;
  }));
});
afterEach(() => {
  vi.unstubAllGlobals();
  errSpy.mockRestore();
  if (savedAgentName === undefined) delete process.env.CTX_AGENT_NAME;
  else process.env.CTX_AGENT_NAME = savedAgentName;
  rmSync(root, { recursive: true, force: true });
});

describe('persona gate casualties — config path (round 1), payload-level', () => {
  it('(a) an arbitrary display_name CANNOT reach the payload — the functional name is sent instead, loudly', async () => {
    writeSlackJson({ display_name: 'Support Bot' });
    const body = await resolveAndPost();
    expect(body.username).toBe(AGENT);
    expect(JSON.stringify(body)).not.toContain('Support Bot');
    expect(logs.some((l) => l.includes("PERSONA GATE: display_name 'Support Bot' SUPPRESSED"))).toBe(true);
  });

  it('(b) icon_emoji CANNOT reach the payload, loudly', async () => {
    writeSlackJson({ display_name: AGENT, icon_emoji: ':smiling_imp:' });
    const body = await resolveAndPost();
    expect('icon_emoji' in body).toBe(false);
    expect(JSON.stringify(body)).not.toContain('smiling_imp');
    expect(logs.some((l) => l.includes('PERSONA GATE: icon_emoji/icon_url'))).toBe(true);
  });

  it('(c) icon_url CANNOT reach the payload, loudly', async () => {
    writeSlackJson({ display_name: AGENT, icon_url: 'https://example.com/evil.png' });
    const body = await resolveAndPost();
    expect('icon_url' in body).toBe(false);
    expect(JSON.stringify(body)).not.toContain('example.com');
    expect(logs.some((l) => l.includes('PERSONA GATE: icon_emoji/icon_url'))).toBe(true);
  });

  it('(d) POLARITY: the approved plain functional name CAN reach the payload, silently', async () => {
    writeSlackJson({ display_name: AGENT });
    const body = await resolveAndPost();
    expect(body.username).toBe(AGENT);
    expect(logs).toEqual([]);
    expect(runtimeWarnings()).toEqual([]);
  });

  it('no slack.json at all → no identity override in the payload (back-compat default)', async () => {
    const body = await resolveAndPost();
    expect('username' in body).toBe(false);
    expect(logs).toEqual([]);
  });

  it('routing-only slack.json (display_name OMITTED) → the functional name is STILL sent, not the app default', async () => {
    // The ordinary config shape: routing present, no persona. The agent-name-only
    // invariant must hold here too — a present-but-nameless config cannot fall
    // through to Slack's app default identity.
    writeSlackJson({ allowed_channels: ['C1'] });
    const body = await resolveAndPost();
    expect(body.username).toBe(AGENT);
    expect(logs).toEqual([]);
    expect(runtimeWarnings()).toEqual([]);
  });

  it('combined worst case: custom name + both icons → payload carries ONLY the functional name', async () => {
    writeSlackJson({
      display_name: 'CEO',
      icon_emoji: ':crown:',
      icon_url: 'https://example.com/ceo.png',
      allowed_channels: ['C1'],
    });
    const body = await resolveAndPost();
    expect(body).toEqual({ channel: 'C1', text: 'hello', username: AGENT });
    expect(logs).toHaveLength(2);
  });
});

describe('runtime crafted-caller casualties (round 2)', () => {
  it("SEAT PROBE r2: (postMessage as any)('C1','hello',{username:'CEO'}) — CEO cannot reach the payload", async () => {
    const SlackAPI = await freshSlackAPI(AGENT);
    const api = new SlackAPI('xoxb-test');
    await (api.postMessage as any)('C1', 'hello', { username: 'CEO' });
    const body = sentBodies[sentBodies.length - 1];
    expect(body.username).toBe(AGENT);
    expect(JSON.stringify(body)).not.toContain('CEO');
    expect(runtimeWarnings().some((l) => l.includes("identity username 'CEO'"))).toBe(true);
  });

  it('crafted icons riding a MATCHING username still never reach the payload', async () => {
    const SlackAPI = await freshSlackAPI(AGENT);
    await (new SlackAPI('xoxb-test').postMessage as any).call(new SlackAPI('xoxb-test'), 'C1', 'hello', {
      username: AGENT,
      iconEmoji: ':crown:',
      icon_emoji: ':crown:',
      icon_url: 'https://example.com/x.png',
    });
    const body = sentBodies[sentBodies.length - 1];
    expect(body).toEqual({ channel: 'C1', text: 'hello', username: AGENT });
  });

  it('POLARITY: a crafted identity whose username already equals the functional name posts silently', async () => {
    const SlackAPI = await freshSlackAPI(AGENT);
    await (new SlackAPI('xoxb-test').postMessage as any).call(new SlackAPI('xoxb-test'), 'C1', 'hello', { username: AGENT });
    const body = sentBodies[sentBodies.length - 1];
    expect(body.username).toBe(AGENT);
    expect(runtimeWarnings()).toEqual([]);
  });
});

// D4 ROUND 3 (seat report f0269f16): the round-2 authority object was public
// structural data — mintable, prototype-poisonable, mutable. All four seat
// bypasses are committed here against the closed capture: each must emit the
// functional name because there is nothing left to forge.
describe('authority-forgery casualties (round 3) — the four seat bypasses', () => {
  it('BYPASS 1 (mint): a caller-minted authority-shaped second constructor arg is inert', async () => {
    const SlackAPI = await freshSlackAPI(AGENT);
    const api = new (SlackAPI as any)('xoxb-test', { agentName: 'executive' });
    await (api.postMessage as any)('C1', 'hello', { username: 'executive' });
    const body = sentBodies[sentBodies.length - 1];
    expect(body.username).toBe(AGENT);
    expect(JSON.stringify(body)).not.toContain('executive');
    expect(runtimeWarnings().some((l) => l.includes("identity username 'executive'"))).toBe(true);
  });

  it('BYPASS 2 (second construction with live context): mutating CTX_AGENT_NAME after module load changes NOTHING', async () => {
    const SlackAPI = await freshSlackAPI(AGENT);
    process.env.CTX_AGENT_NAME = 'executive'; // post-load context mutation
    const api = new (SlackAPI as any)('xoxb-test', { agentName: 'executive' });
    await (api.postMessage as any)('C1', 'hello', { username: 'executive' });
    const body = sentBodies[sentBodies.length - 1];
    expect(body.username).toBe(AGENT);
    expect(JSON.stringify(body)).not.toContain('executive');
  });

  it('BYPASS 3 (prototype): Object.create({agentName/username: executive}) inherits nothing into the payload', async () => {
    const SlackAPI = await freshSlackAPI(AGENT);
    const forged = Object.create({ agentName: 'executive', username: 'executive' });
    const api = new (SlackAPI as any)('xoxb-test', forged);
    await (api.postMessage as any)('C1', 'hello', forged);
    const body = sentBodies[sentBodies.length - 1];
    expect(body.username).toBe(AGENT);
    expect(JSON.stringify(body)).not.toContain('executive');
  });

  it('BYPASS 4 (post-construction mutation): mutating the passed objects after construction changes NOTHING', async () => {
    const SlackAPI = await freshSlackAPI(AGENT);
    const authorityish: any = { agentName: AGENT };
    const identityish: any = { username: AGENT };
    const api = new (SlackAPI as any)('xoxb-test', authorityish);
    authorityish.agentName = 'executive';
    identityish.username = 'executive';
    await (api.postMessage as any)('C1', 'hello', identityish);
    const body = sentBodies[sentBodies.length - 1];
    expect(body.username).toBe(AGENT);
    expect(JSON.stringify(body)).not.toContain('executive');
  });

  it('no daemon-provisioned agent context at module load → identity REFUSED loudly, app default used', async () => {
    const SlackAPI = await freshSlackAPI(undefined);
    const api = new (SlackAPI as any)('xoxb-test', { agentName: 'executive' });
    await (api.postMessage as any)('C1', 'hello', { username: 'executive' });
    const body = sentBodies[sentBodies.length - 1];
    expect('username' in body).toBe(false);
    expect(JSON.stringify(body)).not.toContain('executive');
    expect(runtimeWarnings().some((l) => l.includes('identity REFUSED'))).toBe(true);
  });
});

describe('gateSlackDisplayIdentity unit behavior', () => {
  it('null config yields no identity; icons-only config yields the functional name but still warns', () => {
    expect(gateSlackDisplayIdentity(null, AGENT, log)).toBeUndefined();
    expect(logs).toEqual([]);
    // A present config with no display_name still posts under the functional
    // name (agent-name-only invariant); the icon is suppressed and warned.
    expect(gateSlackDisplayIdentity({ icon_emoji: ':dog:' }, AGENT, log)?.username).toBe(AGENT);
    expect(logs).toHaveLength(1);
  });
});
