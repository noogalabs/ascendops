---
name: google-chat
effort: medium
description: "Connect an agent to a Google Chat space: the agent posts messages and summaries into the space, and anyone in the space can @mention the bot to send a message to the agent. Use when the operator runs on Google Workspace and wants their team to reach the agent (and hear from it) in Google Chat instead of, or alongside, Telegram. Bundles the send + listen scripts, so it ships complete."
triggers: ["google chat", "google chat integration", "chat space", "post to google chat", "@mention bot", "workspace chat", "google workspace chat", "chat bot", "send to chat space", "chat-sender", "chat-listener", "pubsub chat"]
---

# Google Chat integration

This skill bridges an agent and a Google Chat space, both directions:

- **Outbound**: the agent posts messages and summaries into the space (`scripts/chat-sender.js`).
- **Inbound**: anyone in the space can `@mention` the bot; the mention is routed to the agent's inbox (`scripts/chat-listener.js`, run on a cron).

The two scripts are bundled with this skill and have **no npm dependencies** (Node's built-in `crypto` signs the service-account JWT and the global `fetch` does the API calls), so the skill is self-contained once Google Workspace is set up.

---

## What you set up (Google Workspace admin, ~30 min, one time)

You need admin access to Google Workspace, a Google Cloud project, and the service-account key from the steps below.

### Step 1: Create a Google Cloud project (skip if you have one)
1. Go to **https://console.cloud.google.com**, click the project dropdown, **New Project**.
2. Name it (e.g. `your-org-chat-bot`), **Create**.

### Step 2: Enable the Google Chat API
1. Search `Google Chat API`, open it, click **Enable** (if it says **Manage**, it is already on).

### Step 3: Create a service account + key
1. Search `Service Accounts` (under IAM & Admin), **+ Create Service Account**.
2. Name it `chat-bot`, **Create and Continue**, **Done** (no roles needed here).
3. Open it, **Keys** tab, **Add Key > Create new key > JSON**.
4. Save the file as `google-chat-bot-key.json` in `orgs/<your-org>/secrets/`.

### Step 4: Set up Pub/Sub (for inbound @mentions)
1. Search `Pub/Sub`, **+ Create Topic**, Topic ID e.g. `chat-messages-<your-org>`, **Create**.
2. Open the topic, **+ Create Subscription**, Subscription ID `chat-messages-sub`, Delivery type **Pull**, **Create**.
3. Let your **bot** read the subscription: open the subscription, **Permissions / Show info panel > Add Principal** (or **IAM & Admin > IAM > + Grant Access**), paste your service-account email, role **Pub/Sub Subscriber**, **Save**. The bot only needs Subscriber, and only on the subscription, to pull mentions.
4. Let **Google Chat publish** inbound events to the topic: open the topic, **Permissions / Show info panel > Add Principal**, principal `chat-api-push@system.gserviceaccount.com` (Google's fixed Chat push service account, not your bot), role **Pub/Sub Publisher**, **Save**. Without this grant, Chat cannot publish to the topic and the listener pulls nothing.

### Step 5: Configure the Chat app
1. **APIs & Services > Google Chat API > Configuration**.
2. App name: your bot's display name. Avatar URL: blank. Description: short.
3. **Functionality**: check **Receive 1:1 messages** and **Join spaces and group conversations**.
4. **Connection settings**: select **Cloud Pub/Sub**, paste `projects/YOUR-PROJECT-ID/topics/chat-messages-<your-org>` (use your project id + the topic from Step 4).
5. **Visibility**: available to specific people/groups in your domain. **App Status**: **Live**. **Save**.

### Step 6: Add the bot to your space
1. Open **chat.google.com**, open the space, **Apps & integrations > Add apps**, search your bot name, **Add**.

---

## How the agent uses it

Set these in the agent's environment (`.env` or org secrets), no code edits needed:

- `GOOGLE_CHAT_KEY`: path to `google-chat-bot-key.json` (defaults to `orgs/$CTX_ORG/secrets/google-chat-bot-key.json`)
- `GOOGLE_CHAT_PROJECT`: your Google Cloud project id (for the listener)
- `GOOGLE_CHAT_SUBSCRIPTION`: the pull subscription id (defaults to `chat-messages-sub`)
- `CHAT_TARGET_AGENT`: which agent inbound mentions go to (defaults to `$CTX_AGENT_NAME`)

**Post to a space:**
```bash
node scripts/chat-sender.js spaces/YOUR-SPACE-ID "Owner report is ready for your review."
```
(Find `spaces/YOUR-SPACE-ID` in the space URL, or from any inbound message the listener routes.)

**Pull inbound @mentions** (run on a cron so the agent hears the space):
```bash
cortextos bus add-cron <your-agent> chat-listener-poll 10m \
  "Run node <path-to-skill>/scripts/chat-listener.js to pull and route any new Google Chat @mentions to my inbox"
```
The listener pulls pending messages, routes each `@mention` to `<your-agent>`'s inbox via `cortextos bus send-message`, and acknowledges only what it handled (so nothing is reprocessed).

---

## Notes

- **Copilot-safe:** the agent drafts outbound posts the same as any other external message; route them through your approvals gate before sending if that is your posture.
- **No dependencies:** `chat-sender.js`/`chat-listener.js` use only Node built-ins; nothing to `npm install`.
- **The key file is a secret:** keep `google-chat-bot-key.json` in `secrets/` (gitignored), never commit it.
- **Inbound needs the cron running:** if the agent is not hearing mentions, confirm the `chat-listener-poll` cron is active and `GOOGLE_CHAT_PROJECT`/subscription match Step 4.
