#!/usr/bin/env node
// chat-sender.js: post a message to a Google Chat space (dependency-free).
//
// Usage:
//   node chat-sender.js <space> <message...>
//   e.g. node chat-sender.js spaces/AAAAxxxx "Owner report is ready for review."
//
// Auth: service-account key at $GOOGLE_CHAT_KEY (or orgs/$CTX_ORG/secrets/
// google-chat-bot-key.json). The bot must be added to the space (setup Step 6).

'use strict';
const { getAccessToken } = require('./chat-auth');

async function main() {
  const [space, ...rest] = process.argv.slice(2);
  const message = rest.join(' ');
  if (!space || !message) {
    console.error('usage: node chat-sender.js <space e.g. spaces/AAAAxxxx> "<message>"');
    process.exit(2);
  }
  if (!/^spaces\//.test(space)) {
    console.error(`space must look like "spaces/AAAAxxxx" (got "${space}")`);
    process.exit(2);
  }

  const token = await getAccessToken(['https://www.googleapis.com/auth/chat.bot']);
  const res = await fetch(`https://chat.googleapis.com/v1/${space}/messages`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: message }),
  });
  if (!res.ok) {
    console.error(`send failed: ${res.status} ${await res.text()}`);
    process.exit(1);
  }
  const data = await res.json();
  console.log(`sent to ${space}: ${data.name || 'ok'}`);
}

main().catch((e) => {
  console.error(e && e.message ? e.message : e);
  process.exit(1);
});
