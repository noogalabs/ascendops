import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import type { BusPaths } from '../../../src/types';
import { ackInbox, checkInbox, sendMessage } from '../../../src/bus/message';
import { BuzzDispatcher, formatBuzzInboxMessage } from '../../../src/buzz/dispatcher';
import type { BuzzChannelConfig } from '../../../src/buzz/identity';
import type { NostrEvent } from '../../../src/buzz/event';

function paths(root: string, agent: string): BusPaths {
  return {
    ctxRoot: root,
    inbox: join(root, 'inbox', agent),
    inflight: join(root, 'inflight', agent),
    processed: join(root, 'processed', agent),
    logDir: join(root, 'logs', agent),
    stateDir: join(root, 'state', agent),
    taskDir: join(root, 'tasks'),
    approvalDir: join(root, 'approvals'),
    analyticsDir: join(root, 'analytics'),
    deliverablesDir: join(root, 'deliverables'),
  };
}

const config: BuzzChannelConfig = {
  pubkey: 'a'.repeat(64), display_name: 'agent', channels: ['group'], allowed_pubkeys: ['b'.repeat(64)],
};
const event: NostrEvent = {
  id: 'c'.repeat(64), pubkey: 'b'.repeat(64), created_at: 1, kind: 9,
  tags: [['h', 'group']], content: 'hello', sig: 'd'.repeat(128),
};

describe('Buzz durable inbox boundary', () => {
  let root = '';
  afterEach(() => { if (root) rmSync(root, { recursive: true, force: true }); });

  it('creates independently acked inbox records for every matching agent', async () => {
    root = mkdtempSync(join(tmpdir(), 'buzz-durable-'));
    const dispatcher = new BuzzDispatcher();
    dispatcher.register('alpha', config);
    dispatcher.register('beta', config);
    const result = await dispatcher.deliver('group', event, (target) =>
      sendMessage(paths(root, target.agentName), 'daemon', target.agentName, 'normal', formatBuzzInboxMessage(target)));

    expect(result.map((item) => item.messageId)).toHaveLength(2);
    expect(new Set(result.map((item) => item.messageId)).size).toBe(2);
    const [alpha] = checkInbox(paths(root, 'alpha'));
    const [beta] = checkInbox(paths(root, 'beta'));
    expect(alpha.text).toContain('BUZZ TRANSPORT MESSAGE');
    expect(beta.text).toContain('BUZZ TRANSPORT MESSAGE');
    ackInbox(paths(root, 'alpha'), alpha.id);
    expect(checkInbox(paths(root, 'beta')).map((item) => item.id)).toEqual([]);
    expect(beta.id).not.toBe(alpha.id);
  });
});
