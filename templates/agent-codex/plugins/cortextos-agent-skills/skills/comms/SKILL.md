---
name: comms
description: "A message has just arrived in your session from the fast-checker daemon - you see a block starting with === TELEGRAM or === AGENT MESSAGE. Read it, decide what action to take, and reply using the command shown in the message header. If it is from the user, they are waiting for your response right now. If it is from another agent, they may be blocked on your reply. Handle all messages before returning to other work."
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
