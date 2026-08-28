# Buzz (Nostr/NIP-29) Adapter — Setup

This guide documents the adapter contract for an agent that can be messaged
over a Buzz relay (NIP-29 group chat over Nostr).

> **Ships relay-unconfigured — this is the finished state.** Choosing Buzz means
> picking and configuring your own relay and keys. The framework consumes a relay
> URL, an authentication identity, and channel/sender configuration that you
> provide; it never deploys a relay, mints keys, or changes membership. With
> those values absent the adapter simply stays inactive — no default relay
> exists, and you should not invent one.

## 1. Prerequisites

- A `wss://` Buzz relay URL you operate or have access to.
- Your relay's operator tooling (for provisioning agent identities and channel
  membership), available to whoever administers the relay.

## 2. Provision the Nostr authentication identity

Buzz identity minting is a deliberate, out-of-band step. `cortextos
add-agent --buzz-channel` never generates or prints a private key. You provision
the key through your relay's tooling; the framework only consumes the resulting
secret and public identity.

The secret belongs in your secret store and the matching public key
in each participating agent's `buzz.json`. One daemon WebSocket is shared per
org, so every participating agent must name the same injected org
authentication identity. The adapter refuses either a mismatched keypair or a
second agent whose identity conflicts with the connection already registered.

## 3. Register the agent as a relay member

The relay only accepts events from pubkeys it knows about (if
`BUZZ_REQUIRE_RELAY_MEMBERSHIP` is enabled on the relay) or from pubkeys
listed on the `pubkey_allowlist` (if `BUZZ_PUBKEY_ALLOWLIST` is enabled).
Add the agent's public key through your relay's administration workflow. The
framework does not modify relay membership or a relay database.

You'll also need the channel UUID(s) the agent should listen on — ask the
channel owner, or use `cortextos buzz discover-channels` (step 6) once
credentials are in place.

## 4. Create the agent and its `buzz.json`

Create the agent normally:

```bash
cortextos add-agent <name> --org <org>
```

Buzz is configured by a `buzz.json` you author yourself, at
`orgs/<org>/agents/<name>/buzz.json`. It is fail-closed: an agent whose
`allowed_pubkeys` is empty accepts messages from **no one** until you
explicitly grant access. Create it with:

```json
{
  "pubkey": "<agent-hex-pubkey-from-step-2>",
  "display_name": "My Agent",
  "channels": ["<channel-uuid>"],
  "allowed_pubkeys": ["<trusted-sender-hex-pubkey>", "..."],
  "relay_url": "wss://relay.example.com"
}
```

`relay_url` is optional per-agent — if every agent in an org uses the same
relay, set `BUZZ_RELAY_URL` once in the daemon's environment instead and
omit it here.

Inject `BUZZ_PRIVATE_KEY` into the agent secret environment (never committed
to `buzz.json`).

```bash
echo 'BUZZ_PRIVATE_KEY=<hex-secret-key-from-step-2>' >> orgs/<org>/agents/<name>/.env
```

## 5. Understand the connection model

Buzz relays are workspace-scoped like Slack, not per-agent like Telegram: one
WebSocket connection and one authentication identity are shared per org and
owned by the daemon. Every participating agent still needs its own `buzz.json`
(with its own channels and sender `allowed_pubkeys`), but must repeat the same
org authentication pubkey and does not open a second connection. Messages
route through the shared connection based on channel + sender pubkey matching.
Conflicting relay URLs or authentication identities fail closed.

A missing or misconfigured Buzz setup never blocks agent or orchestrator
startup — connection failures are logged and retried with backoff, not
fatal.

## 6. Verify

Before starting the agent, confirm credentials and connectivity:

```bash
cortextos buzz test-send --channel <channel-uuid> --text "hello from cortextOS"
```

This connects, completes the NIP-42 AUTH handshake, publishes a test event,
and waits for the relay's OK — confirming both the private key and relay
reachability are correct before the daemon ever starts.

```bash
cortextos buzz discover-channels --agent <name>
```

Lists the pubkey and channel UUIDs configured in that agent's `buzz.json`.

Then start the agent normally:

```bash
cortextos start <name>
```

## 7. Sending and receiving

Once running, each allowlisted channel event becomes one durable bus inbox
record per matching agent. Deduplication is per `(event, agent)`, acknowledgments
are independent, and a failed target is reported without rolling back siblings.
FastChecker later renders the inbox body through the typed PTY boundary. To
send a message manually or from a script:

```bash
cortextos buzz send --channel <channel-uuid> --text "message text" [--reply-to <event-id>]
# or, from the bus shell scripts:
bus/send-buzz.sh <channel-uuid> "message text"
```

## Scope of this adapter

Text messages in, text messages out — mirrors the initial Telegram/Slack
MVP scope. Not yet implemented: reactions, deletions, threading beyond a
single reply-to tag, presence/typing indicators, media uploads, or dynamic
channel discovery via relay-signed group-state events (channels are
statically configured in `buzz.json` today).
