import { buildAuthEvent, buildChannelMessageEvent, verifyEvent, type NostrEvent } from './event.js';
import { isSecureBuzzRelayUrl } from './identity.js';

export type BuzzMessageHandler = (channelId: string, event: NostrEvent) => void | Promise<void>;

type PendingOk = {
  resolve: (accepted: boolean, message: string) => void;
  timer: ReturnType<typeof setTimeout>;
};

/**
 * Seconds to wait for the relay to send the NIP-42 AUTH challenge after
 * connecting, and for the OK response to the AUTH/publish events. Mirrors
 * the floors buzz-ws-client's connection.rs enforces (>=20s / >=30s) so a
 * slow relay doesn't get treated as dead prematurely.
 */
const AUTH_CHALLENGE_TIMEOUT_MS = 20_000;
const AUTH_OK_TIMEOUT_MS = 20_000;
const PUBLISH_OK_TIMEOUT_MS = 30_000;

const INITIAL_BACKOFF_MS = 1_000;
const MAX_BACKOFF_MS = 60_000;

/**
 * NIP-01 tag shape: an array of arrays of strings. verifyEvent() proves the
 * sender signed exactly this payload — it proves NOTHING about the payload's
 * shape, so every consumer-side dereference of tags depends on this check.
 */
function hasValidTagShape(event: NostrEvent): boolean {
  return (
    Array.isArray(event.tags)
    && event.tags.every((tag) => Array.isArray(tag) && tag.every((v) => typeof v === 'string'))
  );
}

/**
 * One shared WebSocket connection to a Buzz (Nostr/NIP-29) relay, owned at
 * the org level — mirrors Slack Socket Mode's single-shared-connection
 * shape (one relay per org, not one connection per agent) rather than
 * Telegram's per-bot poller shape.
 *
 * Connection lifecycle ported from buzz-ws-client's connection.rs reference
 * (connect -> wait AUTH challenge -> send signed AUTH -> wait OK -> ready)
 * but adapted to Node's event-driven WebSocket API and TelegramPoller's
 * daemon-managed start/stop/reconnect idioms rather than transliterating
 * Rust's blocking async loop.
 */
export class BuzzRelayClient {
  private relayUrl: string;
  private secretKeyHex: string;
  private ws: WebSocket | null = null;
  private running = false;
  private authenticated = false;
  /**
   * Bumped on every connect() call. Frames delivered by a WebSocket instance
   * whose epoch no longer matches `this.epoch` are dropped — same
   * stale-connection guard Slack's socket-mode.ts uses to avoid processing
   * frames from a socket that reconnect() has already superseded.
   */
  private epoch = 0;
  private backoffMs = INITIAL_BACKOFF_MS;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  private messageHandlers: BuzzMessageHandler[] = [];
  private log: (msg: string) => void;

  // Subscriptions this client should (re)establish on every (re)connect.
  private subscribedChannels = new Set<string>();
  // sub_id -> channelId, so incoming EVENT frames can be routed back to a channel.
  private subToChannel = new Map<string, string>();
  // Tracks which sub ids have passed EOSE, so historical backlog is never
  // delivered to onMessage handlers — only live pushes after EOSE, matching
  // the "don't replay old messages on reconnect" posture the design spec
  // calls out (same concern Slack's epoch-guard addresses).
  private eoseSeen = new Set<string>();

  private pendingOks = new Map<string, PendingOk>();
  private pendingAuthChallenge: { resolve: (challenge: string) => void; reject: (reason: string) => void; timer: ReturnType<typeof setTimeout> } | null = null;

  /** Why the client last stopped. Read by daemon supervision to decide whether to restart. */
  lastExitReason: string = '';

  constructor(relayUrl: string, secretKeyHex: string, log: (msg: string) => void = () => {}) {
    if (!isSecureBuzzRelayUrl(relayUrl)) {
      throw new Error('Buzz relay URL must use wss://');
    }
    this.relayUrl = relayUrl;
    this.secretKeyHex = secretKeyHex;
    this.log = log;
  }

  /**
   * Register a handler for incoming channel messages (kind:9 EVENT frames
   * after EOSE has been seen for that subscription).
   */
  onMessage(handler: BuzzMessageHandler): void {
    this.messageHandlers.push(handler);
  }

  /**
   * Registers the set of channel ids to subscribe to. Call before start(),
   * or at any point — an active connection will (re)issue REQ frames for
   * any channels not yet subscribed.
   */
  subscribeChannels(channelIds: string[]): void {
    const added: string[] = [];
    for (const id of channelIds) {
      if (!this.subscribedChannels.has(id)) {
        this.subscribedChannels.add(id);
        added.push(id);
      }
    }
    if (this.authenticated) {
      for (const id of added) this.sendSubscription(id);
    }
  }

  /**
   * Starts the connection lifecycle: connect, authenticate, subscribe, and
   * keep reconnecting with backoff until stop() is called. Resolves once
   * the loop has permanently exited (stopped externally or given up).
   *
   * Non-blocking startup contract: this method's caller (agent-manager.ts)
   * wraps both `new BuzzRelayClient()` construction AND this start() call
   * in try/catch, so a bad relay URL or an outage can never block
   * orchestrator boot.
   */
  async start(): Promise<void> {
    // Fail loud, not retry-forever-silent: native WebSocket is unavailable on
    // older Node, so `new WebSocket` inside the loop would throw ReferenceError
    // on every attempt and reconnect forever with Buzz silently offline. Gate
    // here before the loop, matching the Slack transport's convention.
    if (typeof WebSocket === 'undefined') {
      this.log('WARN: native WebSocket not available — Buzz requires Node 22+; adapter inactive.');
      this.lastExitReason = 'websocket-unavailable';
      return;
    }
    this.running = true;
    this.lastExitReason = '';
    while (this.running) {
      try {
        await this.connectAndRun();
      } catch (err) {
        this.log(`connection error: ${err instanceof Error ? err.message : String(err)}`);
        // Close the failed socket before opening another (post-merge P2): a
        // connect-timeout or AUTH-reject rejection leaves the WebSocket object
        // live otherwise — the epoch guard stops stale frames, but the
        // connection itself would accumulate across reconnect attempts.
        try {
          this.ws?.close();
        } catch {
          /* already dead */
        }
        this.ws = null;
      }
      if (!this.running) {
        this.lastExitReason = 'stopped-externally';
        return;
      }
      this.log(`reconnecting in ${this.backoffMs}ms`);
      await this.sleep(this.backoffMs);
      this.backoffMs = Math.min(this.backoffMs * 2, MAX_BACKOFF_MS);
    }
    this.lastExitReason = 'stopped-externally';
  }

  /** Stops the client. Marks the exit as intentional so it will not restart. */
  stop(): void {
    this.running = false;
    this.authenticated = false;
    this.epoch++; // invalidate any in-flight frames from the current socket
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.rejectAllPending('client stopped');
    try {
      this.ws?.close();
    } catch { /* best-effort */ }
    this.ws = null;
  }

  /**
   * Publishes a kind:9 channel message and waits for the relay's OK.
   * Throws if the connection is not currently authenticated, or if the
   * relay does not OK within PUBLISH_OK_TIMEOUT_MS.
   */
  async publish(channelId: string, content: string, replyToEventId?: string): Promise<NostrEvent> {
    if (!this.ws || !this.authenticated) {
      throw new Error('BuzzRelayClient: not connected/authenticated');
    }
    const event = buildChannelMessageEvent(channelId, content, this.secretKeyHex, replyToEventId);
    const { accepted, message } = await this.sendAndAwaitOk(event, PUBLISH_OK_TIMEOUT_MS);
    if (!accepted) {
      throw new Error(`relay rejected event: ${message}`);
    }
    return event;
  }

  private async connectAndRun(): Promise<void> {
    const myEpoch = ++this.epoch;
    this.authenticated = false;
    this.eoseSeen.clear();

    const ws = new WebSocket(this.relayUrl);
    this.ws = ws;

    await new Promise<void>((resolve, reject) => {
      const openTimer = setTimeout(() => reject(new Error('connect timeout')), 20_000);
      ws.addEventListener('open', () => {
        clearTimeout(openTimer);
        resolve();
      }, { once: true });
      ws.addEventListener('error', () => {
        clearTimeout(openTimer);
        reject(new Error('websocket error during connect'));
      }, { once: true });
    });

    if (myEpoch !== this.epoch) return; // superseded while connecting

    this.log('connected, waiting for AUTH challenge');

    const messagesDone = new Promise<void>((resolve) => {
      ws.addEventListener('close', () => {
        if (myEpoch === this.epoch) {
          this.authenticated = false;
          this.rejectAllPending('connection closed');
        }
        resolve();
      }, { once: true });
    });

    ws.addEventListener('message', (evt) => this.handleFrame(myEpoch, String(evt.data)));
    ws.addEventListener('error', () => {
      // Handled via 'close' — WebSocket fires close after error.
    });

    const challenge = await this.waitForAuthChallenge(myEpoch);
    if (myEpoch !== this.epoch) return;

    const authEvent = buildAuthEvent(challenge, this.relayUrl, this.secretKeyHex);
    const { accepted, message } = await this.sendAndAwaitOk(authEvent, AUTH_OK_TIMEOUT_MS);
    if (myEpoch !== this.epoch) return;
    if (!accepted) {
      throw new Error(`AUTH rejected: ${message}`);
    }

    this.authenticated = true;
    this.backoffMs = INITIAL_BACKOFF_MS; // reset backoff on a clean successful auth
    this.log('NIP-42 authentication successful');

    this.sendSubscriptions();

    await messagesDone;
  }

  private sendSubscriptions(): void {
    if (!this.ws) return;
    for (const channelId of this.subscribedChannels) {
      this.sendSubscription(channelId);
    }
  }

  private sendSubscription(channelId: string): void {
    const subId = `buzz-${channelId}`;
    this.subToChannel.set(subId, channelId);
    this.eoseSeen.delete(subId);
    this.sendRaw(['REQ', subId, { kinds: [9], '#h': [channelId] }]);
  }

  private waitForAuthChallenge(myEpoch: number): Promise<string> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingAuthChallenge = null;
        reject(new Error('timed out waiting for AUTH challenge'));
      }, AUTH_CHALLENGE_TIMEOUT_MS);
      this.pendingAuthChallenge = {
        resolve: (challenge: string) => {
          if (myEpoch !== this.epoch) return;
          clearTimeout(timer);
          resolve(challenge);
        },
        reject: (reason: string) => {
          clearTimeout(timer);
          reject(new Error(reason));
        },
        timer,
      };
    });
  }

  private sendAndAwaitOk(event: NostrEvent, timeoutMs: number): Promise<{ accepted: boolean; message: string }> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingOks.delete(event.id);
        reject(new Error('timed out waiting for OK'));
      }, timeoutMs);
      this.pendingOks.set(event.id, {
        resolve: (accepted, message) => {
          clearTimeout(timer);
          resolve({ accepted, message });
        },
        timer,
      });
      const frameType = event.kind === 22242 ? 'AUTH' : 'EVENT';
      this.sendRaw([frameType, event]);
    });
  }

  private sendRaw(value: unknown): void {
    if (!this.ws) return;
    this.ws.send(JSON.stringify(value));
  }

  private handleFrame(myEpoch: number, raw: string): void {
    if (myEpoch !== this.epoch) return; // stale connection — ignore

    let arr: unknown[];
    try {
      arr = JSON.parse(raw);
    } catch {
      return;
    }
    const type = arr[0];

    switch (type) {
      case 'AUTH': {
        const challenge = arr[1];
        if (typeof challenge === 'string' && this.pendingAuthChallenge) {
          this.pendingAuthChallenge.resolve(challenge);
          this.pendingAuthChallenge = null;
        }
        break;
      }
      case 'OK': {
        const eventId = arr[1];
        const accepted = Boolean(arr[2]);
        const message = typeof arr[3] === 'string' ? arr[3] : '';
        if (typeof eventId === 'string') {
          const pending = this.pendingOks.get(eventId);
          if (pending) {
            this.pendingOks.delete(eventId);
            pending.resolve(accepted, message);
          }
        }
        break;
      }
      case 'EOSE': {
        const subId = arr[1];
        if (typeof subId === 'string') this.eoseSeen.add(subId);
        break;
      }
      case 'EVENT': {
        const subId = arr[1];
        const nostrEvent = arr[2] as NostrEvent | undefined;
        if (typeof subId !== 'string' || !nostrEvent) break;
        // Skip historical backlog delivered before EOSE for this subscription.
        if (!this.eoseSeen.has(subId)) break;
        const channelId = this.subToChannel.get(subId);
        if (!channelId) break;
        // Shape-validate tags BEFORE any dereference (post-merge P1): the
        // signature covers whatever the sender serialized, so a correctly
        // signed kind-9 event can still carry tags that are null, an object,
        // or an array with non-array entries — dereferencing those throws
        // inside this synchronous frame handler. Malformed shape = drop, the
        // same disposition as a bad signature.
        if (nostrEvent.kind !== 9 || !hasValidTagShape(nostrEvent) || !verifyEvent(nostrEvent)) {
          this.log(`dropping unverifiable Buzz event on subscription ${subId}`);
          break;
        }
        const eventChannel = nostrEvent.tags.find((tag) => tag[0] === 'h')?.[1];
        if (eventChannel !== channelId) {
          this.log(`dropping Buzz event ${nostrEvent.id}: channel tag does not match subscription`);
          break;
        }
        for (const handler of this.messageHandlers) {
          Promise.resolve().then(() => handler(channelId, nostrEvent)).catch((err) => {
            this.log(`message handler error: ${err instanceof Error ? err.message : String(err)}`);
          });
        }
        break;
      }
      case 'NOTICE':
      case 'CLOSED':
      case 'COUNT':
        // Not needed for the MVP text-in/text-out scope; log and ignore.
        break;
      default:
        break;
    }
  }

  private rejectAllPending(reason: string): void {
    for (const [, pending] of this.pendingOks) {
      clearTimeout(pending.timer);
      pending.resolve(false, reason);
    }
    this.pendingOks.clear();
    if (this.pendingAuthChallenge) {
      // Settle the waiter — clearing only the timer would leave
      // waitForAuthChallenge()'s promise suspended forever, so connectAndRun()
      // never returns and the reconnect loop dies on a socket-close-before-AUTH.
      this.pendingAuthChallenge.reject(reason);
      this.pendingAuthChallenge = null;
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
