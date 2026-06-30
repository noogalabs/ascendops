// chat-auth.js: dependency-free Google service-account auth.
//
// Exchanges a service-account key (the google-chat-bot-key.json from setup) for a
// short-lived OAuth2 access token using the JWT-bearer flow, with zero npm
// dependencies: Node's built-in `crypto` signs the JWT (RS256) and the global
// `fetch` (Node 18+) does the token exchange. Shared by chat-sender.js and
// chat-listener.js.

'use strict';
const crypto = require('crypto');
const fs = require('fs');

// base64url without padding, per JWT spec.
function b64url(input) {
  return Buffer.from(input)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

/**
 * Resolve the service-account key path. Override with GOOGLE_CHAT_KEY; otherwise
 * default to the per-org secrets location from the setup guide.
 *
 * NOTE: the key lives in the cortextos CHECKOUT at orgs/<org>/secrets/ (where the
 * setup guide tells you to save it), so the default base is CTX_FRAMEWORK_ROOT (the
 * checkout root), NOT CTX_ROOT (the state root, e.g. ~/.cortextos/<instance>). Set
 * GOOGLE_CHAT_KEY to an absolute path if your key lives anywhere else.
 */
function resolveKeyPath() {
  if (process.env.GOOGLE_CHAT_KEY) return process.env.GOOGLE_CHAT_KEY;
  const root = process.env.CTX_FRAMEWORK_ROOT || '.';
  const org = process.env.CTX_ORG || '';
  return `${root}/orgs/${org}/secrets/google-chat-bot-key.json`;
}

/**
 * Get an OAuth2 access token for the given scopes from a service-account key.
 * @param {string[]} scopes e.g. ['https://www.googleapis.com/auth/chat.bot']
 * @param {string} [keyPath] override the key file path
 * @returns {Promise<string>} the access token
 */
async function getAccessToken(scopes, keyPath = resolveKeyPath()) {
  let key;
  try {
    key = JSON.parse(fs.readFileSync(keyPath, 'utf8'));
  } catch (err) {
    throw new Error(`could not read service-account key at ${keyPath}: ${err.message}`);
  }
  if (!key.client_email || !key.private_key) {
    throw new Error(`service-account key at ${keyPath} is missing client_email/private_key`);
  }

  const now = Math.floor(Date.now() / 1000);
  const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claims = b64url(JSON.stringify({
    iss: key.client_email,
    scope: scopes.join(' '),
    aud: 'https://oauth2.googleapis.com/token',
    iat: now,
    exp: now + 3600,
  }));
  const signingInput = `${header}.${claims}`;
  const signature = crypto.sign('RSA-SHA256', Buffer.from(signingInput), key.private_key);
  const assertion = `${signingInput}.${b64url(signature)}`;

  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion,
    }),
  });
  if (!res.ok) {
    throw new Error(`token exchange failed: ${res.status} ${await res.text()}`);
  }
  const data = await res.json();
  if (!data.access_token) throw new Error('token exchange returned no access_token');
  return data.access_token;
}

module.exports = { getAccessToken, resolveKeyPath, b64url };
