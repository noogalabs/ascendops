---
name: comms
description: "A message has just arrived in your session from the fast-checker daemon — you see a block starting with === TELEGRAM or === AGENT MESSAGE. Read it, decide what action to take, and reply using the command shown in the message header. If it is from the user, they are waiting for your response right now. If it is from another agent, they may be blocked on your reply. Handle all messages before returning to other work."
triggers: ["=== TELEGRAM", "=== AGENT MESSAGE", "message received", "incoming message", "reply to", "telegram from", "agent message from", "fast-checker", "message injected", "respond to message", "handle message", "incoming telegram", "message block"]
---

# Handling Incoming Messages

Messages are delivered in real time by the fast-checker daemon running alongside your session. You will see them appear in your input as formatted blocks.

## Message Format

```
=== TELEGRAM from <name> (chat_id:<id>) ===
<message text>
Reply using: cortextos bus send-telegram <chat_id> '<your reply>'

=== AGENT MESSAGE from <agent> [msg_id: <id>] ===
<message text>
Reply using: cortextos bus send-message <agent> normal '<your reply>' <msg_id>
```

Treat outbound message text as shell data. Keep the entire payload single-quoted. If it contains an apostrophe, close the quote, add the standard shell literal sequence `'\''`, and reopen it (or rewrite the sentence without the apostrophe). Never switch the payload to double quotes: dollar signs and backticks would be expanded by the shell.

```bash
cortextos bus send-telegram "$CTX_TELEGRAM_CHAT_ID" 'I'\''ve approved $250; `date` remains literal.'
```

## What To Do

1. Read every message block in the injected content
2. For each message, take action or respond using the `Reply using:` command shown in the header
3. For agent messages, always include the `msg_id` as the reply_to argument so conversations thread correctly
4. The fast-checker handles temp file cleanup automatically

## David-Facing Evidence and Confidence Gate

Before sending any material factual claim to David, classify the claim itself. Do not assign one confidence label to a paragraph containing mixed states.

1. **Confirmed** - established by David's direct statement or an authoritative artifact that matches the claim's subject, scope, date, and timezone.
2. **My read** - an inference from stated evidence. Label it exactly as a read and name the evidence and the unresolved alternative.
3. **Not confirmed** - the available record does not settle it. Say what source or check is needed next.

Use plain language in the reply:

- `Confirmed: <fact>.`
- `My read from <evidence>: <inference>, but <alternative> is not ruled out.`
- `I'm not sure yet. I need to check <source>, and I will come back with the result.`

**Silence is not the safe fallback.** If David asked a question and the answer is not available, promptly state that it is not confirmed and what you are checking. Do not guess, and do not disappear.

### Claim checks before send

For every material claim, verify:

- **Source:** Is this a primary/authoritative artifact, David's direct statement, an agent's reported finding, or a third-party summary?
- **Subject:** Does the evidence describe the same system, property, person, or process as the claim?
- **Scope:** Does a fact about one subsystem support a claim about the whole operation?
- **Time:** Are the date, freshness, and timezone established?
- **Number:** Is a price, count, duration, or operating hour sourced from the business or provider record?

A web-search summary, third-party blog, or vendor comparison may identify what to investigate. It MUST NOT be presented as AscendOps' price, spend, coverage, configuration, or current operating fact without authoritative confirmation. If useful before confirmation, call it a third-party estimate and keep it separate from company figures.

**Relaying is endorsing.** An agent's finding arrives as evidence, not as a verified fact. Apply the same subject and scope checks to it that you would to your own claim, and carry its own CANNOT-ESTABLISH labels through to David rather than resolving them in transit.

Words such as `likely`, `looks like`, `probably`, and `appears` are inference markers, not evidence. They require the **My read** form above. Do not bridge an evidence gap with fluent wording.

When direct evidence later contradicts a sent claim:

1. correct David plainly;
2. identify which source or inference failed;
3. state the replacement fact and its evidence; and
4. do not over-correct to silence.

## Composing Your Reply (format per audience)

Handling a message is two steps, not one: decide the action, then WRITE the reply. The command in the header only covers *how to send*, not *what to say*. Match the reply to the audience.

**Human-facing (David, residents, vendors, techs) → short, answer-first, plain.**
- Lead with the answer or the ask. Put it in the first sentence.
- Cut background, cut context you were not asked for, cut narrating back the steps you took or what you told someone else.
- Do not tell people what to do beyond what the situation needs. No upsells ("One thing for you: want me to also...").
- No embellishment. No commitments David has not authorized (do not tell a resident "we'll send a crew" before the go).
- Pre-send check: **"Would 2-3 plain sentences cover this?"** If yes, send those. "Done." / "Got it." is a complete reply.

**Agent-to-agent / docs (bus messages to peers, memory, specs) → structured is fine.** Bullets, headers, code blocks help scanning here. The concision rule above is for humans, not peers.

CONSEQUENCE: over-verbose human replies get corrected. David lock 2026-07-03: "Stop adding extra context. Stop telling people what to do. Stop talking for the sake of talking... be TERSE... applies to EVERYTHING." See fleet lessons format-per-audience (locked 2026-05-27) and plain-language-with-David.

## Priority

- `urgent` priority inbox messages: handle immediately, save current work state first
- Callback queries (inline button presses): process the callback_data and acknowledge via `send-telegram`
- Photos: local file path is provided, use it directly

## Waiting for a Response

If you send a Telegram message that asks a question and you need the answer before continuing your work, you MUST end your current response entirely (stop all tool execution, produce no more output). The user's reply will be injected into your conversation as your next turn by the fast-checker. If you keep executing tools after sending the question, the reply gets queued by Claude Code and you will never see it until your turn ends. End your turn, and the reply arrives.

## Done

After handling all messages, return to your current task or wait for the next injection.
