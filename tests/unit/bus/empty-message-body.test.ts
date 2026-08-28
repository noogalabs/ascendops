import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readdirSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { sendMessage, checkInbox } from '../../../src/bus/message';
import type { BusPaths } from '../../../src/types';

/**
 * Regression: an empty message body was a SILENT loss across the whole bus.
 *
 * `sendMessage` validated `from`, `to` and `priority` and never validated `text`, so an
 * empty body was accepted, HMAC-signed, written, delivered and ACK'd with every layer
 * reporting success. Measured before the fix: 19 empty bodies across 43,457 stored
 * messages, 5 distinct senders, 2026-04-24 through 2026-08-03 — a live low-rate loss.
 *
 * Every test here must FAIL against pre-fix main. A test that passes both ways proves
 * nothing about a defect whose entire signature is "nothing happened".
 */

function pathsFor(ctxRoot: string, agent: string, org = 'ascendops'): BusPaths {
  const orgBase = join(ctxRoot, 'orgs', org);
  return {
    ctxRoot,
    inbox: join(ctxRoot, 'inbox', agent),
    inflight: join(ctxRoot, 'inflight', agent),
    processed: join(ctxRoot, 'processed', agent),
    logDir: join(ctxRoot, 'logs', agent),
    stateDir: join(ctxRoot, 'state', agent),
    taskDir: join(orgBase, 'tasks'),
    approvalDir: join(orgBase, 'approvals'),
    analyticsDir: join(orgBase, 'analytics'),
    deliverablesDir: join(orgBase, 'deliverables'),
  } as BusPaths;
}

function inboxFileCount(ctxRoot: string, agent: string): number {
  const dir = join(ctxRoot, 'inbox', agent);
  if (!existsSync(dir)) return 0;
  return readdirSync(dir).filter((f) => f.endsWith('.json')).length;
}

describe('empty message body is rejected at the primitive', () => {
  let ctxRoot: string;

  beforeEach(() => {
    ctxRoot = mkdtempSync(join(tmpdir(), 'cortextos-empty-body-'));
  });

  afterEach(() => {
    rmSync(ctxRoot, { recursive: true, force: true });
  });

  // THE MOTIVATING FIXTURE (rex, 2026-08-03): a PR review verdict arrived with a
  // zero-length body. It was signed, delivered and ACKable — indistinguishable from a
  // real message except that it said nothing. The reviewer believed the verdict was sent.
  it('refuses the verdict-loss shape: a review verdict sent with an empty body', () => {
    const paths = pathsFor(ctxRoot, 'moss');
    expect(() => sendMessage(paths, 'kit', 'moss', 'normal', '')).toThrow(/[Ee]mpty message body/);
  });

  it('produces NO side effects when it rejects — no inbox file, nothing to ACK', () => {
    const paths = pathsFor(ctxRoot, 'moss');
    expect(() => sendMessage(paths, 'kit', 'moss', 'normal', '')).toThrow();
    // The whole point of failing before the write: a rejected send must not leave a
    // half-message that a receiver could pick up and ACK.
    expect(inboxFileCount(ctxRoot, 'moss')).toBe(0);
    expect(checkInbox(paths)).toHaveLength(0);
  });

  it('rejects whitespace-only bodies, which are equally silent on arrival', () => {
    const paths = pathsFor(ctxRoot, 'moss');
    for (const body of [' ', '   ', '\n', '\t', '\n\n  \t ']) {
      expect(() => sendMessage(paths, 'kit', 'moss', 'normal', body)).toThrow(/[Ee]mpty message body/);
    }
    expect(inboxFileCount(ctxRoot, 'moss')).toBe(0);
  });

  it('rejects an empty forward from each caller-supplied call site shape', () => {
    // The 3 sites that forward a caller-supplied body rather than a template literal:
    // bus/agents.ts:324 and cli/bus.ts:2254 (urgent-signal message), and
    // daemon/agent-manager.ts:115 (notifyOrchestrator text). All three are 'urgent' or
    // 'normal' sends of a variable, which is exactly the shape that can arrive empty.
    const paths = pathsFor(ctxRoot, 'rex');
    expect(() => sendMessage(paths, 'moss', 'rex', 'urgent', '')).toThrow(/[Ee]mpty message body/);
    expect(() => sendMessage(paths, 'daemon', 'rex', 'normal', '')).toThrow(/[Ee]mpty message body/);
  });

  // Guard against over-correction. The fix must not break real traffic — the 8 call sites
  // that build template literals send bodies that are short, or whitespace-padded, or
  // punctuation-led, and every one of them must still go through.
  it('still sends legitimate bodies, including short and padded ones', () => {
    const paths = pathsFor(ctxRoot, 'moss');
    const legit = [
      'ok',
      '.',
      '0',
      '  leading and trailing whitespace  ',
      '\nApproval decision: APPROVED\napproval_id: a1\n',
      'Task assigned: [normal] Fix the thing (id: task_1)',
    ];
    for (const body of legit) {
      expect(() => sendMessage(paths, 'kit', 'moss', 'normal', body)).not.toThrow();
    }
    expect(inboxFileCount(ctxRoot, 'moss')).toBe(legit.length);
  });

  it('preserves the body exactly — rejection must not become trimming', () => {
    // Rejecting empty is not licence to normalise non-empty input. A body that survives
    // the gate must arrive byte-identical, padding included.
    const paths = pathsFor(ctxRoot, 'moss');
    const body = '  padded body with edges  ';
    sendMessage(paths, 'kit', 'moss', 'normal', body);
    const [msg] = checkInbox(paths);
    expect(msg.text).toBe(body);
  });
});
