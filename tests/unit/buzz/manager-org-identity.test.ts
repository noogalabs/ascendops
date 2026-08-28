import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { AgentManager } from '../../../src/daemon/agent-manager';
import { BuzzDispatcher } from '../../../src/buzz/dispatcher';
import { getPublicKey } from '../../../src/buzz/event';

const FIRST_SECRET = '0000000000000000000000000000000000000000000000000000000000000003';
const SECOND_SECRET = '0000000000000000000000000000000000000000000000000000000000000004';

describe('AgentManager shared Buzz org identity', () => {
  let root = '';

  afterEach(() => {
    if (root) rmSync(root, { recursive: true, force: true });
  });

  it('refuses a second agent whose injected auth identity differs', async () => {
    root = mkdtempSync(join(tmpdir(), 'buzz-org-identity-'));
    const secondAgentDir = join(root, 'orgs', 'acme', 'agents', 'second');
    mkdirSync(secondAgentDir, { recursive: true });
    writeFileSync(join(secondAgentDir, 'buzz.json'), JSON.stringify({
      pubkey: getPublicKey(SECOND_SECRET),
      display_name: 'second',
      channels: ['group-1'],
      allowed_pubkeys: [],
      relay_url: 'wss://relay.example.com',
    }));
    writeFileSync(join(secondAgentDir, '.env'), `BUZZ_PRIVATE_KEY=${SECOND_SECRET}\n`);

    const manager = new AgentManager('test', root, root, 'acme');
    const fakeClient = {
      subscribeChannels: () => {},
      start: async () => {},
      stop: () => {},
    };
    (manager as any).buzzClients.set('acme', {
      client: fakeClient,
      dispatcher: new BuzzDispatcher(),
      relayUrl: 'wss://relay.example.com',
      authPubkey: getPublicKey(FIRST_SECRET),
      started: true,
    });

    await expect((manager as any).maybeRegisterBuzzAgent(
      'second', 'acme', secondAgentDir, () => {},
    )).rejects.toThrow('Buzz auth identity conflicts with the existing shared connection');
  });
});
