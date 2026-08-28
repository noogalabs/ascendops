# Slack reconciliation — build spec

Design spec for the Slack transport reconciliation. The transport core here is
canonical; the reconciliation is a behavior checklist applied to it, not a
wholesale transplant.

## 0. The architectural crux

The two implementations differ in CONNECTION TOPOLOGY, and every fold decision
follows from it:

| | ours (canonical) | upstream 8475381d |
|---|---|---|
| socket | one `SlackSocketListener` per agent, from that agent's `.env` | one shared workspace socket, orchestrator-owned |
| routing | 1:1 agent↔channel, implicit | N:1 via each agent's `slack.json` gates |
| delivery | durable inbox (`sendMessage` → bus) | direct `FastChecker` PTY queueing |
| identity | server-side `team_members` trust enrichment (unspoofable) | `team_id:user_id` composite allowlist |
| degraded Node<22 | poll fallback (no silent gap) | inactive |

We keep our topology and our delivery. We adopt their ROUTING MODEL as a
per-agent config layer that sits in front of delivery.

## 1. D1 — per-agent `slack.json`, both identity layers composed

New file `orgs/<org>/agents/<name>/slack.json` (non-secret; tokens stay in
`.env`):

```json
{
  "display_name": "sample-agent",
  "channels": { "ops": "C123", "approvals": "C456" },
  "allowed_channels": ["C123", "C456"],
  "allowed_users": ["T01ABC:U01XYZ"]
}
```

**Composition rule (ruled, load-bearing).** The two identity systems are
sequential filters, not alternatives:

1. **Route gate (theirs, fail-closed):** does this agent's `allowed_channels`
   contain the event channel, AND does `allowed_users` contain
   `<team_id>:<user_id>`? Empty/missing list denies. Nothing proceeds without
   both.
2. **Trust enrichment (ours, server-side):** the surviving event is resolved
   through `slack-identity.ts` against `team_members`; `trustLevel` is derived
   server-side and attached to the delivered text. Never read from payload.

Neither replaces the other: (1) decides IF the agent receives it, (2) decides
WHAT the agent knows about the sender. An agent with no `slack.json` keeps
today's `.env`-driven 1:1 behavior exactly (back-compat, no forced migration).

## 2. D2 — routing composed onto our delivery (the constrained delta)

**TOPOLOGY CORRECTION (PR313 review).** Slack distributes an app's event
envelopes ACROSS its open Socket Mode connections — each event reaches ONE
connection, not all of them. N:1 therefore does NOT come from several listeners
sharing one app: it comes from **one Slack app per agent**. Each agent's own
app, subscribed and invited to a channel, receives its OWN full copy of that
channel's events, and each agent's listener gates and delivers independently.
A single app shared by several agents splits events between them at random
(silent per-agent loss) — unsupported, and agent-manager warns loudly (log +
operator Telegram) when two agents claim the same app token.

- **Their contribution:** the ROUTING MODEL — one channel event may match
  MULTIPLE agents, each evaluated independently against its own `slack.json`
  gates. Every non-delivery is a named, logged deny (an invisible non-delivery
  is indistinguishable from a lost message).
- **Our contribution:** each delivery is a durable inbox write
  (`sendMessage(paths, 'fast-checker', <agent>, 'normal', text)`) — NOT a direct
  PTY queue. Custody survives restart; the typed injection boundary stays the
  only path into a PTY. There is no central dispatcher: per-agent listeners ARE
  the fan-out.

### 2.1 One-to-N dedup and ack semantics (REQUIRED written design)

A single Slack event fanning out to N agents raises three questions that must be
answered by construction, not emergently:

**(a) Dedup identity is PER (event, agent), never per event.**
The dedup key is `slack:<team_id>:<channel>:<event_ts>:<agent_name>`.
Rationale: `event_ts` is Slack's stable per-message id, so a socket redelivery
(reconnect replay, duplicate frame) collapses for each agent independently. If
the key omitted the agent, the first agent's delivery would suppress every other
agent's — the fan-out would silently degrade to 1:1, which is exactly the
one-to-N failure this section exists to prevent. Casualty: `casualty:
fan-out-collapse` — two agents on one channel, one event, both must receive.

**(b) Acks are independent and never cross-agent.**
Each inbox write produces its own message id, acked by its own agent on its own
schedule. No agent's ack affects another's copy. There is no shared "the event
was handled" state, because there is no shared consumer. Casualty:
`casualty: cross-agent-ack-bleed` — agent A acking must leave agent B's copy
unacked and deliverable.

**(c) Partial-failure is per-agent and loud.**
If agent B's inbox write throws while agent A's succeeded, A keeps its delivery
and B's listener logs its own failure with the event id — a write failure is
never folded into a routing denial, and B's dedup window stays CLEAR (the
reservation is released) so a redelivery can still land. We do NOT roll back A
— a delivered message is custody taken. Because each agent's delivery is its
own listener's own write, one agent's failure structurally cannot suppress
another's. Casualty: `casualty: partial-fanout-visibility` — a thrown write
must surface a named log line and must not poison the window.

## 3. D3 — CLI siblings

Add to the existing `bus.ts` Slack surface (we already have `send-slack`):
`slack-test-send` (post to a channel, print the API result) and
`slack-discover-channels` (list channels the bot is in, with ids — the
config-authoring aid `slack.json` needs). Same token resolution as `send-slack`.

## 4. D4 — display identity: MECHANISM ONLY, VALUES GATED

Plumb `display_name`/`icon_emoji`/`icon_url` from `slack.json` through
`SlackAPI.postMessage` as `username`/`icon_*` overrides.

**GATE (ruled, STRUCTURAL — hardened after the heavy-seat RED):** every agent
ships with its plain functional name (e.g. `sample-agent`), no custom icons.
Custom display names/icons are member-visible persona surface and are blocked
pending the brand/persona review. Enforcement is on the production path, not in
prose, in TWO layers at the final primitive (round 2: a unique-symbol brand is
erased at runtime, so the compile layer alone cannot stop an `as any` or
plain-JS caller):

1. **Compile time:** `SlackAPI.postMessage` accepts only the branded
   `GatedDisplayIdentity` type, which only `gateSlackDisplayIdentity` can
   produce — and the gate permits nothing but the agent's functional name (a
   custom `display_name` is loudly suppressed and replaced;
   `icon_emoji`/`icon_url` have no payload field at all).
2. **Runtime (round 3 — no caller-supplied authority survives):** the round-2
   constructor-supplied authority object was itself forgeable (mintable,
   prototype-poisonable, mutable after construction — four proven bypasses).
   The emitted username now comes ONLY from a module-private primitive const
   captured at MODULE LOAD from the daemon-provisioned agent context
   (`CTX_AGENT_NAME`, else the agent dir's `.cortextos-env`; the cwd-basename
   fallback of `resolveEnv` is deliberately omitted as cwd-mintable). It is
   not exported and not a constructor input: nothing to mint, no prototype
   chain to poison, a const primitive that post-load env/cwd mutation cannot
   re-run. `postMessage` treats the identity parameter as the opt-in signal
   plus a claim to verify loudly — the payload is always written from the
   captured value; with no captured context, identity is loudly refused.
   Icons cannot be expressed in the body regardless of caller shape.

**Boundary honestly stated:** these layers fence API callers inside a
daemon-provisioned process. An adversary controlling process START context, or
holding the raw bot token, is outside any in-process fence — that layer is
held server-side by Slack: the `chat:write.customize` scope is withheld until
the persona review (runbook §1/§5), so Slack itself drops overrides.

A hand-edited `slack.json` — or a crafted runtime caller, forged authority
included — therefore CANNOT ship a persona. When persona-review
authority exists, approved values are admitted by extending the gate — a
deliberate code change, never a config drop. Casualties: payload-level tests in
`tests/unit/slack/persona-gate.test.ts` prove (a) arbitrary name, (b)
icon_emoji, (c) icon_url cannot reach the payload and (d) the functional name
can, all through the production resolve→post path.

## 5. D5 / D6 — runbook + shell parity

- `docs/runbook/slack-adapter-setup.md` adapted to OUR env/paths/topology
  (documents the `.env` tokens, `slack.json` shape, the poll-fallback behavior,
  and restart-to-apply).
- `bus/send-slack.sh` + `bus/_slack-curl.sh` for transport parity with the other
  shell entrypoints.

## 6. Do-not-fold (ruled)

- **D7 their `socket-mode.ts`:** ours is canonical. Theirs degrades inactive on
  Node<22 — the silent-no-inbound class our `slack-inbound-mode.ts` decision
  function exists to prevent.
- **D8 their `agent-manager`/`fast-checker` seams:** both files changed through
  the six-family catch-up (typed boundary, listener ownership). D1/D2 integration
  is re-derived on our seams.

## 7. Acceptance bar (HEAVY)

Test matrix: telegram-only, slack-only, dual-enabled, missing-token,
denied-user, reconnect, self-echo, shutdown — plus back-compat (no `slack.json`
→ today's behavior byte-for-byte).

**Whole-daemon consumer census** for the new ingress: enumerate every path an
inbound Slack event can reach a PTY or an inbox, and show each one passes
through the route gate. An unfenced ingress is a finding.

**Paired-polarity casualties** on every gate: the three §2.1 casualties above,
plus channel-gate and user-gate denial (must-die) each paired with an
allowed-case control (must-pass) — a gate that only ever denies is
indistinguishable from a broken gate.
