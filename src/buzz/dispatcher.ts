import type { NostrEvent } from './event.js';
import { isBuzzChannelConfigured, isBuzzPubkeyAllowed, type BuzzChannelConfig } from './identity.js';
import { stripControlChars } from '../utils/validate.js';

/**
 * Routes incoming Buzz (Nostr kind:9) channel-message events to every
 * registered agent whose `buzz.json` matches BOTH gates:
 *   1. channel match — the agent listens on the event's channel, and
 *   2. pubkey match — the event author is in the agent's allowed_pubkeys.
 *
 * Buzz channels are N:1 (an agent can be a member of several channels, and
 * a channel can have several member agents) — unlike Telegram's 1:1
 * bot-per-agent shape, a single relay connection fans an incoming message
 * out to every matching agent, not just the first.
 */

export interface BuzzDispatchTarget {
  agentName: string;
  config: BuzzChannelConfig;
}

export interface BuzzDispatchResult {
  agentName: string;
  event: NostrEvent;
  channelId: string;
}

export type BuzzDeliveryStatus = 'delivered' | 'deduped' | 'deliveryFailed';

export interface BuzzDeliveryResult extends BuzzDispatchResult {
  status: BuzzDeliveryStatus;
  messageId?: string;
  error?: string;
}

export type BuzzDeliver = (target: BuzzDispatchResult) => Promise<string> | string;

export function formatBuzzInboxMessage(target: BuzzDispatchResult): string {
  return [
    'BUZZ TRANSPORT MESSAGE',
    `Sender pubkey: ${target.event.pubkey}`,
    `Channel: ${target.channelId}`,
    `Event: ${target.event.id}`,
    '',
    stripControlChars(target.event.content),
    '',
    `Reply using: cortextos buzz send --channel ${target.channelId} --text '<your reply>' --reply-to ${target.event.id}`,
  ].join('\n');
}

/**
 * Registry of agents this daemon knows to be listening on Buzz. The relay
 * client's onMessage handler feeds events through `dispatch()`.
 */
export class BuzzDispatcher {
  private targets: Map<string, BuzzDispatchTarget> = new Map();
  private delivered = new Set<string>();
  /**
   * In-flight write per (event, agent) key → a promise resolving true when
   * that write DURABLY succeeded, false when it FAILED. A concurrent
   * redelivery awaits this instead of being discarded on sight: it dedups only
   * against a winner that actually succeeded, and retries its own write when
   * the winner failed. This closes the double-delivery TOCTOU WITHOUT opening
   * the lost-delivery hole a discard-on-reservation would (post-merge P1 v2).
   */
  private inFlight = new Map<string, Promise<boolean>>();
  private static readonly MAX_DEDUP_ENTRIES = 10_000;

  /** Registers or updates an agent's Buzz config. */
  register(agentName: string, config: BuzzChannelConfig): void {
    this.targets.set(agentName, { agentName, config });
  }

  /** Removes an agent from dispatch (e.g. on stopAgent). */
  unregister(agentName: string): void {
    this.targets.delete(agentName);
  }

  /**
   * Computes every agent that should receive this event: channel match AND
   * pubkey-allowed match. Delivers to all matches, not just the first.
   */
  dispatch(channelId: string, event: NostrEvent): BuzzDispatchResult[] {
    const results: BuzzDispatchResult[] = [];
    for (const target of this.targets.values()) {
      if (!isBuzzChannelConfigured(target.config, channelId)) continue;
      if (!isBuzzPubkeyAllowed(target.config, event.pubkey)) continue;
      results.push({ agentName: target.agentName, event, channelId });
    }
    return results;
  }

  /**
   * Writes one independently-acknowledgeable durable message per matching
   * agent. A failed target never rolls back a successful sibling and is not
   * marked delivered, so a relay redelivery can retry only that target.
   */
  async deliver(
    channelId: string,
    event: NostrEvent,
    write: BuzzDeliver,
    log: (message: string) => void = () => {},
  ): Promise<BuzzDeliveryResult[]> {
    const outcomes: BuzzDeliveryResult[] = [];
    for (const target of this.dispatch(channelId, event)) {
      const key = `buzz:${event.id}:${target.agentName}`;
      outcomes.push(await this.deliverOne(key, target, write, log, event));
    }
    return outcomes;
  }

  /**
   * Deliver one (event, agent) pair with await-the-winner dedup.
   *
   * A duplicate does not discard on sight — it awaits whatever write is
   * already in flight for this key. If that winner SUCCEEDED, this is a true
   * duplicate (deduped). If the winner FAILED, this copy is the redelivery
   * that must retry — it loops to become (or await) the next in-flight write.
   * The loop is bounded: a failed write deletes its own in-flight entry in the
   * finally, so the next iteration either finds a fresh writer to await or
   * becomes the writer itself and settles.
   */
  private async deliverOne(
    key: string,
    target: BuzzDispatchResult,
    write: BuzzDeliver,
    log: (message: string) => void,
    event: NostrEvent,
  ): Promise<BuzzDeliveryResult> {
    while (true) {
      if (this.delivered.has(key)) return { ...target, status: 'deduped' };
      const existing = this.inFlight.get(key);
      if (!existing) break;
      const won = await existing;
      if (won) return { ...target, status: 'deduped' };
      // Winner failed — re-check delivered/in-flight and retry.
    }

    let settle!: (won: boolean) => void;
    const promise = new Promise<boolean>((resolve) => { settle = resolve; });
    this.inFlight.set(key, promise);
    try {
      const messageId = await write(target);
      this.markDelivered(key);
      settle(true);
      return { ...target, status: 'delivered', messageId };
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      log(`Buzz deliveryFailed event=${event.id} agent=${target.agentName}: ${detail}`);
      settle(false);
      return { ...target, status: 'deliveryFailed', error: detail };
    } finally {
      // Only clear the entry if it is still ours — a later retry may have
      // already installed its own promise under this key.
      if (this.inFlight.get(key) === promise) this.inFlight.delete(key);
    }
  }

  private markDelivered(key: string): void {
    this.delivered.add(key);
    while (this.delivered.size > BuzzDispatcher.MAX_DEDUP_ENTRIES) {
      const oldest = this.delivered.values().next().value as string | undefined;
      if (!oldest) break;
      this.delivered.delete(oldest);
    }
  }

  /** Union of every channel id across all registered agents — what the relay client should subscribe to. */
  allChannels(): string[] {
    const channels = new Set<string>();
    for (const target of this.targets.values()) {
      for (const c of target.config.channels) channels.add(c);
    }
    return [...channels];
  }
}
