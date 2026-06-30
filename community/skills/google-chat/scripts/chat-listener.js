#!/usr/bin/env node
// chat-listener.js: pull Google Chat @mentions from a Pub/Sub subscription and
// route them to an agent's inbox (dependency-free). Run it on a cron (see SKILL.md).
//
// Config (env):
//   GOOGLE_CHAT_PROJECT       your Google Cloud project id            (required)
//   GOOGLE_CHAT_SUBSCRIPTION  the pull subscription id                (default: chat-messages-sub)
//   CHAT_TARGET_AGENT         agent to deliver mentions to            (default: $CTX_AGENT_NAME)
//   GOOGLE_CHAT_KEY           service-account key path                (default per setup guide)
//
// It pulls pending messages, routes each @mention to the agent inbox via
// `cortextos bus send-message`, and acknowledges only the messages it handled.

'use strict';
const { getAccessToken } = require('./chat-auth');
const { execFileSync } = require('child_process');
const { join } = require('path');

const PUBSUB = 'https://pubsub.googleapis.com/v1';

async function main() {
  const project = process.env.GOOGLE_CHAT_PROJECT;
  const sub = process.env.GOOGLE_CHAT_SUBSCRIPTION || 'chat-messages-sub';
  const agent = process.env.CHAT_TARGET_AGENT || process.env.CTX_AGENT_NAME;
  if (!project) {
    console.error('set GOOGLE_CHAT_PROJECT to your Google Cloud project id');
    process.exit(2);
  }
  if (!agent) {
    console.error('set CHAT_TARGET_AGENT (or run with CTX_AGENT_NAME set) so mentions have a destination');
    process.exit(2);
  }

  const token = await getAccessToken(['https://www.googleapis.com/auth/pubsub']);
  const pullRes = await fetch(`${PUBSUB}/projects/${project}/subscriptions/${sub}:pull`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ maxMessages: 10 }),
  });
  if (!pullRes.ok) {
    console.error(`pull failed: ${pullRes.status} ${await pullRes.text()}`);
    process.exit(1);
  }
  // An idle subscription can return HTTP 200 with an empty body; JSON.parse('') throws,
  // so a healthy no-message poll (the common quiet-space cron path) would exit 1. Read
  // as text and treat an empty body as {} before parsing.
  const pullText = await pullRes.text();
  const { receivedMessages = [] } = pullText.trim() ? JSON.parse(pullText) : {};

  const ackIds = [];
  let hadRouteFailure = false;
  for (const rm of receivedMessages) {
    // Ack ONLY after a message is genuinely handled, never before. Acking up front
    // (the previous behavior) meant a transient route failure or a misconfigured agent
    // permanently dropped a user's mention. We ack on three outcomes: parse failure
    // (poison payload, redelivery cannot help), no actionable text, or a successful
    // route. A FAILED route is left un-acked so Pub/Sub redelivers it.
    let text = '';
    let sender = 'someone';
    let spaceName = 'a space';
    try {
      const raw = Buffer.from(rm.message.data || '', 'base64').toString('utf8');
      const evt = JSON.parse(raw);
      // Google Chat MESSAGE event shape.
      text = (evt.message && evt.message.text) || '';
      sender = (evt.message && evt.message.sender && evt.message.sender.displayName) || 'someone';
      spaceName =
        (evt.space && evt.space.name) ||
        (evt.message && evt.message.space && evt.message.space.name) ||
        'a space';
    } catch (err) {
      // Unparseable payload: ack so a poison message is not redelivered forever.
      console.error('dropping an unparseable Pub/Sub message (acked):', err.message);
      ackIds.push(rm.ackId);
      continue;
    }
    if (!text.trim()) {
      // Nothing actionable (membership/system event, empty text): ack and move on.
      ackIds.push(rm.ackId);
      continue;
    }
    try {
      // Give the agent an explicit path to reply INTO the Google Chat space. The inbox
      // framing auto-appends a generic "Reply using: cortextos bus send-message ..."
      // line, but replying on the bus does NOT reach Chat - the agent must use
      // chat-sender.js with this space id. Add the hint only for a real space id.
      const senderPath = join(__dirname, 'chat-sender.js');
      const replyHint = /^spaces\//.test(spaceName)
        ? `\n(To reply in this Google Chat space, do NOT reply via the bus; run: node ${senderPath} ${spaceName} "your reply")`
        : '';
      const body = `[Google Chat] ${sender} in ${spaceName}: ${text}${replyHint}`;
      // --skip-lint: the body is a verbatim quote of an external person's Chat message,
      // which is exactly the legitimate-quoted case comms-lint exempts. Without it,
      // ordinary user wording would trip the outbound lint, throw, and (now that we ack
      // only after a successful route) loop forever on Pub/Sub redelivery. The agent's
      // OWN outbound messages are still linted; only this inbound relay is exempt.
      execFileSync('cortextos', ['bus', 'send-message', agent, 'normal', body, '--skip-lint'], { stdio: 'inherit' });
      ackIds.push(rm.ackId); // ack ONLY after a successful route
    } catch (err) {
      // Transient route failure (CLI down, agent misconfigured): leave the message
      // un-acked so Pub/Sub redelivers the mention instead of dropping it, and record
      // the failure so the run exits nonzero (cron supervision must not see success).
      console.error('route failed, leaving message for redelivery:', err.message);
      hadRouteFailure = true;
    }
  }

  if (ackIds.length) {
    const ackRes = await fetch(`${PUBSUB}/projects/${project}/subscriptions/${sub}:acknowledge`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ ackIds }),
    });
    if (!ackRes.ok) {
      // A non-2xx acknowledge means these messages are NOT acked: Pub/Sub will
      // redeliver them and the next cron run would inject duplicate Chat messages.
      // Fail loudly (mirror the pull path) instead of logging success.
      console.error(`acknowledge failed: ${ackRes.status} ${await ackRes.text()}`);
      process.exit(1);
    }
  }
  console.log(`processed ${receivedMessages.length} message(s), routed to ${agent}`);
  if (hadRouteFailure) {
    // At least one message failed to route (left un-acked for redelivery). Exit nonzero
    // so cron supervision sees the failed run instead of a false success; the messages
    // that DID route are already acked above and will not redeliver.
    process.exit(1);
  }
}

main().catch((e) => {
  console.error(e && e.message ? e.message : e);
  process.exit(1);
});
