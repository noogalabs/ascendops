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
  const { receivedMessages = [] } = await pullRes.json();

  const ackIds = [];
  for (const rm of receivedMessages) {
    ackIds.push(rm.ackId); // ack everything we pulled so it is not redelivered
    try {
      const raw = Buffer.from(rm.message.data || '', 'base64').toString('utf8');
      const evt = JSON.parse(raw);
      // Google Chat MESSAGE event shape.
      const text = (evt.message && evt.message.text) || '';
      const sender = (evt.message && evt.message.sender && evt.message.sender.displayName) || 'someone';
      const spaceName =
        (evt.space && evt.space.name) ||
        (evt.message && evt.message.space && evt.message.space.name) ||
        'a space';
      if (text.trim()) {
        const body = `[Google Chat] ${sender} in ${spaceName}: ${text}`;
        execFileSync('cortextos', ['bus', 'send-message', agent, 'normal', body], { stdio: 'inherit' });
      }
    } catch (err) {
      console.error('skipped a message (parse/route error):', err.message);
    }
  }

  if (ackIds.length) {
    await fetch(`${PUBSUB}/projects/${project}/subscriptions/${sub}:acknowledge`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ ackIds }),
    });
  }
  console.log(`processed ${receivedMessages.length} message(s), routed to ${agent}`);
}

main().catch((e) => {
  console.error(e && e.message ? e.message : e);
  process.exit(1);
});
