/**
 * Minimal Slack Web API client using built-in fetch (Node 20+).
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { redactSSN } from '../utils/ssn-redaction.js';
import type { GatedDisplayIdentity } from './slack-routing.js';

/**
 * RUNTIME AGENT TRUTH (D4 round 3) — the ONLY source the emitted display
 * username can ever come from.
 *
 * Captured ONCE at module load from the daemon-provisioned agent context
 * (CTX_AGENT_NAME in the environment, else the agent dir's .cortextos-env
 * file), into a module-private primitive const. It is NOT exported, NOT a
 * constructor input, NOT an object:
 *   - cannot be MINTED: no public API accepts a name (round-3 bypass 1/2);
 *   - cannot be SUBCLASSED: a primitive has no prototype chain to poison
 *     (bypass 3);
 *   - cannot be MUTATED: a const string binding, and post-load mutation of
 *     process.env or cwd cannot re-run this capture (bypass 4).
 * The deliberately-omitted cwd-basename fallback of resolveEnv is omitted
 * BECAUSE it is mintable by cwd choice.
 *
 * Boundary honestly stated: this fences API CALLERS in a daemon-provisioned
 * process. An adversary who controls process START context (env/launch) — or
 * who holds the raw bot token — is outside any in-process fence; that layer
 * is held by Slack itself: the chat:write.customize scope is withheld until
 * the persona review (runbook §1/§5), so the server rejects overrides.
 */
const RUNTIME_AGENT_NAME: string | undefined = (() => {
  try {
    const fromEnv = process.env.CTX_AGENT_NAME?.trim();
    if (fromEnv) return fromEnv;
    const envPath = join(process.cwd(), '.cortextos-env');
    if (existsSync(envPath)) {
      const match = readFileSync(envPath, 'utf-8').match(/^CTX_AGENT_NAME=(.+)$/m);
      if (match?.[1]?.trim()) return match[1].trim();
    }
    return undefined;
  } catch {
    return undefined;
  }
})();

export interface SlackMessage {
  ts: string;
  user?: string;
  username?: string;
  /**
   * Optional: captionless file/photo shares (subtype `file_share`) arrive with
   * NO text field. Callers must render a missing text as an empty body, never
   * interpolate it directly (which prints the literal string "undefined").
   */
  text?: string;
  type: string;
  subtype?: string;
  bot_id?: string;
}

/**
 * Timeout for Slack Web API calls. Without it a black-holed connection hangs
 * the await forever — and checkSlackWatch is awaited inside the fast-checker
 * tick loop, so one hung call would stall ALL inbound (Telegram included)
 * until daemon restart.
 */
const API_TIMEOUT_MS = 10_000;

export class SlackAPI {
  private readonly baseUrl = 'https://slack.com/api';
  private readonly token: string;

  // D4 round 3: the constructor deliberately accepts NO identity input. The
  // round-2 SlackIdentityAuthority was public structural data — mintable,
  // prototype-poisonable, mutable after construction (four proven bypasses).
  // The emitted username now comes only from the module-private
  // RUNTIME_AGENT_NAME above; there is nothing for a caller to supply.
  constructor(token: string) {
    this.token = token;
  }

  /**
   * Shared fetch wrapper: bounded timeout + HTTP-status checking before JSON
   * parsing. Slack app-level errors come back HTTP 200 with `ok:false` (the
   * caller checks those), but transport-level failures (429 rate limit, 5xx,
   * proxy HTML pages) would otherwise surface as an opaque JSON parse error.
   * 429s include the Retry-After header in the error message so operators can
   * see the server-requested pause in the log line.
   */
  private async requestJson<T>(path: string, init: RequestInit): Promise<T> {
    const response = await fetch(`${this.baseUrl}/${path}`, {
      ...init,
      signal: AbortSignal.timeout(API_TIMEOUT_MS),
    });
    if (!response.ok) {
      if (response.status === 429) {
        const retryAfter = response.headers.get('retry-after');
        throw new Error(
          `Slack API ${path} rate limited (HTTP 429${retryAfter ? `, retry after ${retryAfter}s` : ''})`,
        );
      }
      throw new Error(`Slack API ${path} failed: HTTP ${response.status}`);
    }
    return await response.json() as T;
  }

  async postMessage(
    channel: string,
    text: string,
    identity?: GatedDisplayIdentity,
  ): Promise<void> {
    // Scrub at the egress primitive: never SHARE an SSN to Slack.
    text = redactSSN(text);
    // D4 PERSONA GATE, layered at the final primitive:
    //  - COMPILE TIME: only the branded GatedDisplayIdentity type-checks, and
    //    only gateSlackDisplayIdentity can produce one.
    //  - RUNTIME (rounds 2+3): the brand is erased at runtime and any passed
    //    OBJECT is forgeable, so neither is ever trusted for the payload. The
    //    identity parameter is only the OPT-IN SIGNAL (and a claim to verify
    //    loudly); the emitted username is written from the module-private
    //    RUNTIME_AGENT_NAME captured at load — a value no caller can mint,
    //    subclass, or mutate. Icons have no payload field at all, regardless
    //    of caller shape.
    const body: Record<string, unknown> = { channel, text };
    if (identity !== undefined) {
      const warn = (line: string) => console.error(line);
      const claimed: unknown = (identity as { username?: unknown }).username;
      if (RUNTIME_AGENT_NAME === undefined) {
        warn(
          'PERSONA GATE (runtime): display identity requested but this process has no daemon-provisioned agent context (CTX_AGENT_NAME) — identity REFUSED, sending with the app default name.',
        );
      } else {
        if (claimed !== RUNTIME_AGENT_NAME) {
          warn(
            `PERSONA GATE (runtime): identity username '${String(claimed)}' does not match this process's agent functional name '${RUNTIME_AGENT_NAME}' — SUPPRESSED, sending the functional name.`,
          );
        }
        body.username = RUNTIME_AGENT_NAME;
      }
    }
    const data = await this.requestJson<{ ok: boolean; error?: string }>('chat.postMessage', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${this.token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });
    if (!data.ok) {
      throw new Error(`Slack postMessage failed: ${data.error ?? 'unknown'}`);
    }
  }

  async getHistory(channel: string, oldest: string): Promise<SlackMessage[]> {
    const params = new URLSearchParams({ channel, oldest, limit: '50', inclusive: 'false' });
    const data = await this.requestJson<{ ok: boolean; messages?: SlackMessage[]; error?: string }>(
      `conversations.history?${params}`,
      { headers: { 'Authorization': `Bearer ${this.token}` } },
    );
    if (!data.ok) {
      throw new Error(`Slack conversations.history failed: ${data.error ?? 'unknown'}`);
    }
    return (data.messages ?? []).reverse();
  }

  async getUserName(userId: string): Promise<string> {
    try {
      const params = new URLSearchParams({ user: userId });
      const data = await this.requestJson<{ ok: boolean; user?: { real_name?: string; name?: string } }>(
        `users.info?${params}`,
        { headers: { 'Authorization': `Bearer ${this.token}` } },
      );
      if (data.ok && data.user) {
        return data.user.real_name ?? data.user.name ?? userId;
      }
    } catch { /* fall through */ }
    return userId;
  }

  /**
   * Resolve a user's Slack handle + display name via users.info.
   * Returns null on ok:false or any error (never throws) so callers can
   * treat lookup failure as "unresolved" and retry later.
   */
  async getUserInfo(
    userId: string,
  ): Promise<{ handle: string | null; displayName: string } | null> {
    try {
      const params = new URLSearchParams({ user: userId });
      const data = await this.requestJson<{
        ok: boolean;
        user?: { name?: string; real_name?: string; profile?: { display_name?: string } };
      }>(`users.info?${params}`, {
        headers: { 'Authorization': `Bearer ${this.token}` },
      });
      if (data.ok && data.user) {
        const handle = data.user.name ?? null;
        const displayName =
          data.user.real_name ?? data.user.profile?.display_name ?? data.user.name ?? userId;
        return { handle, displayName };
      }
    } catch { /* fall through */ }
    return null;
  }

  /**
   * Resolve the authenticated bot's own user id via auth.test.
   *
   * Used by the inbound path to drop the agent's own outbound messages
   * (self-echo guard). Returns null on ok:false or any error (never throws) so
   * a failed lookup degrades to "own id unknown" — the caller skips the
   * own-id check rather than killing inbound entirely.
   */
  async getBotUserId(): Promise<string | null> {
    return (await this.getAuthIdentity())?.userId ?? null;
  }

  /**
   * Own bot identity from auth.test: user id (self-echo guard) AND team id
   * (the workspace scope for composite `team:user` route-gate keys — a
   * single-workspace app's own team is by construction the team every inbound
   * event belongs to).
   */
  /**
   * Channels the bot can see, for `slack.json` authoring
   * (`cortextos bus slack-discover-channels`). Paginates conversations.list;
   * `memberOnly` filters to channels the bot has been invited into — the ones
   * inbound can actually arrive from.
   */
  async listChannels(memberOnly = true): Promise<Array<{ id: string; name: string; isMember: boolean }>> {
    const channels: Array<{ id: string; name: string; isMember: boolean }> = [];
    let cursor = '';
    do {
      const params = new URLSearchParams({
        types: 'public_channel,private_channel',
        limit: '200',
        ...(cursor ? { cursor } : {}),
      });
      const data = await this.requestJson<{
        ok: boolean;
        error?: string;
        channels?: Array<{ id: string; name: string; is_member?: boolean }>;
        response_metadata?: { next_cursor?: string };
      }>(`conversations.list?${params.toString()}`, {
        method: 'GET',
        headers: { 'Authorization': `Bearer ${this.token}` },
      });
      if (!data.ok) {
        throw new Error(`Slack conversations.list failed: ${data.error ?? 'unknown'}`);
      }
      for (const c of data.channels ?? []) {
        const isMember = c.is_member === true;
        if (!memberOnly || isMember) channels.push({ id: c.id, name: c.name, isMember });
      }
      cursor = data.response_metadata?.next_cursor ?? '';
    } while (cursor !== '');
    return channels;
  }

  async getAuthIdentity(): Promise<{ userId: string; teamId: string } | null> {
    try {
      const data = await this.requestJson<{ ok: boolean; user_id?: string; team_id?: string }>('auth.test', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${this.token}` },
      });
      if (data.ok && data.user_id && data.team_id) {
        return { userId: data.user_id, teamId: data.team_id };
      }
    } catch { /* fall through */ }
    return null;
  }
}
