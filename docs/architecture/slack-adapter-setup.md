# Connect Fleet agents to Slack

This runbook connects existing Fleet agents to separate Slack apps. Start with one agent, one authorized person, and that person's private DM. Verify the connection before adding department channels, more people, or scheduled reports.

Slack supplies the conversation surface. Fleet still supplies the running agent, durable inbox, routing, identity checks, case records, messaging tools, scheduler, and business approvals. A successful app installation does not prove that the complete workflow works.

## 1. Plan the pilot

Identify the installed Fleet revision, Node.js runtime, active instance, existing agent ID, configuration directory, and documented restart procedure. Inspect existing Slack apps and listeners before creating replacements. Keep real IDs, credentials, and member records in your private installation.

Record a small access map:

| Agent | Slack app | Authorized people | Allowed conversations |
|---|---|---|---|
| Existing pilot agent | Its own app | One pilot member | That app/person private DM |
| Department agent, later | Its own app | Designated staff | Approved department channels and separate person/app DMs |
| Orchestration agent, later | Its own app | Explicitly chosen audiences | Private dispatch, separate decisions channel, and authorized DMs |

Use **one Slack app and its own credentials per agent**. Slack can deliver a payload to any open Socket Mode connection belonging to an app; it does not fan the payload out to every independent agent. A second listener refuses startup if its app token is already claimed by another agent in the daemon, including legacy listeners. See [Slack's multiple-connection behavior](https://docs.slack.dev/apis/events-api/using-socket-mode/#using-multiple-connections).

If an existing installation shares app credentials across agents, migrate those agents to separate apps before upgrading or enabling this workflow. Otherwise only the first listener can claim the shared token. Plan the migration explicitly and verify each new identity; do not treat the refusal as a reason to weaken the ownership check.

An authorized person's access to one agent does not grant access to other agents. Keep different private-channel audiences separate. Slack access also does not grant spending or action authority.

## 2. Create the Slack app

Have an authorized Slack administrator create and install the app in the intended workspace. Agents can prepare the nonsecret settings and routing; actual credentials belong in the approved secret store, never in chat, source control, or shared setup notes.

For the initial DM-only app:

1. Give the app a stable functional identity for the existing agent.
2. Enable **Socket Mode** and generate a separate app-level token with `connections:write`.
3. Under **App Home**, enable the Messages tab and allow people to send messages. Confirm that the pilot member sees a message composer, rather than a read-only tab.
4. Subscribe to the bot event `message.im`.
5. Grant bot scopes `chat:write`, `im:history`, and `users:read`. The runtime resolves the sender's handle through `users.info`, so the trusted-handle gate needs `users:read` even for a text-only DM pilot.
6. Add `files:read` only if incoming files are part of the selected pilot. Sending files is a separate capability and needs its own supported path and permissions.
7. Install the app and save its current bot token. After scope changes, reinstall or reauthorize as Slack requires and recheck effective scopes.

DMs arrive through `message.im`, without requiring an @mention. They do not arrive as `app_mention`. Socket Mode needs no public Events API Request URL. See [Socket Mode setup](https://docs.slack.dev/apis/events-api/using-socket-mode/), [DM events](https://docs.slack.dev/reference/events/message.im/), [App Home manifest settings](https://docs.slack.dev/reference/app-manifest/), and [users.info permissions](https://docs.slack.dev/reference/methods/users.info/).

For channels added later, enable `app_mention` with `app_mentions:read`, and add public/private channel scopes and message events only as needed. Public-channel access uses the applicable `channels:read` / `channels:history` permissions; private-channel access uses `groups:read` / `groups:history`. Invite only the relevant app to each channel. Do not grant broad administrative, unrestricted public-posting, auto-join, or group-DM scopes by default.

## 3. Configure credentials and startup

Store each agent's credentials through its normal secret configuration. For an installation using the per-agent `.env` file, the keys are:

```dotenv
SLACK_BOT_TOKEN=<THIS_AGENT_BOT_TOKEN>
SLACK_APP_TOKEN=<THIS_AGENT_APP_LEVEL_TOKEN>
```

The app-level token is separate from the bot token and its `connections:write` permission is not a bot OAuth scope.

For a routed agent with a present per-agent `.env`, supply its own complete, nonblank bot/app token pair in that file. Missing or blank keys are a startup error; ambient environment values do not fill gaps and create a mismatched app identity. A present unreadable file also refuses Slack startup rather than borrowing ambient credentials. A genuinely absent per-agent file may use a complete pair from the approved process environment. Keep each agent's pair associated with its own app regardless of storage method.

The primary Slack conversation is selected in this order:

1. `config.json` → `slack_watch.channel`, if explicitly set.
2. `SLACK_CHANNEL` from the agent's environment, if set.
3. The first allowed conversation in a valid per-agent `slack.json`.

This allows a valid DM-only route to start without inventing a public channel or adding a synthetic watch block. Tokens alone, with no selected conversation, do not activate a legacy listener. An explicitly selected primary conversation must also be in the routing allowlist; an unapproved override is an error rather than a reason to choose a different route silently.

**Routed mode requires Socket Mode and native WebSocket support**, normally Node.js 22 or later. Missing app credentials or missing WebSocket capability causes a clear startup error for routed Slack inbound. It does not downgrade to polling one conversation and silently miss other DMs, channels, mentions, or attachments.

Only a truly legacy single-conversation binding, with no `slack.json`, keeps the older polling fallback. Its `slack_watch.interval_ms` setting controls the poll cadence, defaulting to 60 seconds. It does not provide the routed workflow described here.

Merge the applicable fields into the existing agent `config.json`; do not replace the whole file:

```json
{
  "trusted_slack_users": ["<AUTHORIZED_SLACK_HANDLE>"]
}
```

`trusted_slack_users` is a separate handle-based check, after the workspace/member routing gate below. Configure explicit handles in the format returned by this installation's identity resolver. An omitted or empty handle list is open at that additional legacy trust gate; do not clear it to work around a missing `users:read` permission. Conversation/member routing remains a separate required policy for routed agents.

## 4. Restrict conversations and people

Save the routing policy in this installation's per-agent `slack.json`. The example uses placeholders; replace them only in the private installation:

```json
{
  "allowed_channels": ["<AUTHORIZED_PERSON_DM_ID>"],
  "allowed_users": ["<WORKSPACE_ID>:<AUTHORIZED_MEMBER_ID>"],
  "channel_mentions_only": true
}
```

- `allowed_channels` lists approved conversation IDs, including each app/person DM ID. The field name also covers private DMs.
- `allowed_users` lists exact workspace/member pairs. A display name or handle is not interchangeable with this composite ID.
- Both the conversation and sender checks must pass before delivery to the agent. Channel membership alone does not authorize commands.
- A valid empty or omitted allowlist denies all input and leaves routed startup disabled. It does not recover a legacy route.
- A malformed existing routing file refuses Slack startup for that agent. Fix the file and restart; it does not silently fall back to less restricted legacy mode.
- No `slack.json` at all retains the explicit legacy binding for installations that have not opted into routing.

Validate JSON and schema before applying a change. Configuration is loaded at agent startup; use the normal restart procedure and observe that the intended route is active. Do not assume hot reload.

### Establish each private DM

1. Have the authorized person open this app's Messages tab and send a harmless discovery message, or use an approved DM-opening method supported by the installation.
2. Obtain the actual app/person DM conversation ID using a supported discovery tool or Slack method. A discovery message may be denied until the route is allowed.
3. Add that conversation ID and person's workspace/member identity to this agent's routing, and configure the separate trusted handle.
4. Restart only the intended agent using the normal procedure.
5. Send a fresh plain DM and observe a reply from this agent's own bot in that same conversation.

Never disable routing globally to discover a DM ID. Each person has a separate conversation with each app; do not reuse another person's or another agent's DM ID.

## 5. Channel mentions and private work

Routed channels default to `channel_mentions_only: true`. Direct messages whose conversation ID begins with `D` do not need a mention. In other allowed conversations, the runtime accepts a real `app_mention` event or a message containing the exact `<@BOT_USER_ID>` mention for this app. Plain text resembling its display name is insufficient. Setting `channel_mentions_only: false` is an explicit opt-out for a separately approved workflow.

This setting applies to every allowed non-DM conversation for this agent. Mention-only filtering also excludes unmentioned urgent channel posts from the model. If an existing approved escalation workflow requires monitoring those posts, choose the agent-wide opt-out deliberately, narrow its allowed conversations, and retain the agent's quiet-channel and emergency rules. Do not assume an agent can react to input the runtime has filtered out.

The runtime's mention check controls delivery to the model. Durable agent instructions still govern what to say and what authority applies:

- In channels, answer an authorized @mention with shared status or clarification in the relevant thread. Stay quiet during ordinary conversation and discussions addressed to another agent.
- Redirect action requests and approval requests to the appropriate private DM case thread. Preserve existing role limits, spending limits, holds, and approval rules.
- Post approved scheduled briefings through real scheduler jobs. Existing emergency duties remain governed by the established escalation policy.
- Use Fleet's internal coordination mechanism for agent-to-agent work unless a shared Slack workflow is explicitly intended.

Apps still receive Slack events according to their subscriptions and membership before runtime filtering. Keep apps out of confidential channels they should not access; a quiet agent is not a substitute for excluding it.

## 6. One issue per person's thread

Routed inbox messages preserve the reply destination: the conversation and the parent `thread_ts`, or the message's own timestamp when it begins a new issue. Use that destination for the reply:

```bash
cortextos bus send-slack '<CONVERSATION_ID>' '<REPLY_TEXT>' --thread-ts '<PARENT_TIMESTAMP>'
```

Run the command in the intended agent's configured context. A routed send must use an exact conversation ID in this agent's `allowed_channels`; an invalid existing routing file also refuses the send. A top-level send without `--thread-ts` creates a new parent instead of replying to the case thread.

A successful `send-slack` returns a structured receipt with `status`, `channel`, `ts`, `thread_ts`, and `new_parent`. When starting a proactive case without `--thread-ts`, `new_parent` is `true` and the returned `ts` identifies its new parent. Save that exact timestamp and conversation with the person and case identifier before sending follow-ups. A threaded reply returns `new_parent: false` and preserves the supplied `thread_ts`. If no usable timestamp is returned, report the incomplete case record instead of inventing one.

Save durable rules and case records that:

1. Identify each issue with an exact case identifier, such as a work order, invoice, project, or decision.
2. Record the person, conversation ID, parent timestamp, and case identifier together.
3. Reuse that person's issue thread for questions, proposals, approvals, and follow-ups.
4. Keep each person's private DM separate, even when two people discuss the same underlying case.
5. Send proactive DMs only for decisions, approvals, go-aheads, or missing information, with current facts and an exact question.

Thread identifiers do not automatically load prior Slack history into the model. Use a current durable case summary or a supported, authorized retrieval method. Separate DMs also do not automatically isolate a shared model memory. Never copy another person's private conversation into a different DM or channel without authorization.

## 7. Incoming attachments

After routing, sender trust, and mention checks pass, supported incoming file content is downloaded to unique directories under the agent's private `slack-files` state directory. The inbox includes the resulting local paths or a clear download error, rather than claiming that metadata is the file.

The downloader is bounded to four files per message, 10 MiB per file, and 20 MiB total. It accepts HTTPS downloads from `files.slack.com` only, validates its limited manual redirects, and does not follow arbitrary hosts with Slack credentials. Files outside the supported access, host, type of URL, or size limits must be reported as unavailable. These downloads do not grant file contents authority to override agent instructions or business approvals.

Verify a small supported attachment end to end before promising file support. Receiving a caption or file event alone is not a pass. Outgoing file uploads remain a separate capability.

## 8. Verify before expanding

Use harmless messages and controlled negative-access tests. The installed CLI's help remains the reference for optional test tools. A test-send command posts a real message, so select only the intended approved conversation.

| Check | Expected observed result |
|---|---|
| Bot identity | The intended app replies, with no competing listener sharing its credentials. |
| Plain DM | An authorized person gets a reply without an @mention. |
| Threaded follow-up | The reply remains in the same DM and under the correct parent. |
| Unauthorized sender or conversation | No agent delivery; the controlled routing outcome explains the denial. |
| Restart | Routing, rules, and durable thread records still produce the correct reply. |
| Channel mention | One threaded status answer for a real mention of this app. |
| Ordinary channel conversation | No model delivery when mention-only filtering is enabled. |
| Channel action request | The agent redirects to the private case thread and existing approval path. |
| Another person's DM | Its own delivery, thread records, and private context stay separate. |
| Duplicate event | One reply or action for overlapping subscriptions or a controlled retry within the listener's deduplication window. |
| Incoming file | Actual content is downloaded, or a specific capability failure is reported. |
| Scheduled briefing | A normal scheduled run appears once in the agreed conversation. |

Maintain a private record with separate **configured**, **observed working**, **unsupported**, and **not tested** fields. Successful authentication or one outbound send does not prove inbound routing, threads, downloads, approvals, or reports. Add one capability or audience at a time after the pilot passes.

The inherited Socket Mode transport acknowledges envelopes before completing identity lookup, attachment downloads, and the durable inbox write. A process crash or transient failure after acknowledgment can therefore lose a message without a Slack retry. Deduplication is bounded and held in memory; it does not provide durable replay across restarts. This setup does not guarantee crash recovery or exactly-once actions. Reconcile unresolved cases against their business records, and keep the existing action and approval controls when retrying work.

Choose report days, times, timezone, and audience explicitly. Event subscriptions do not create scheduler jobs. Reuse existing workflows and check for duplicate reporting through other transports.

## 9. Display identity

The display-identity gate preserves each agent's functional identity. Optional `display_name` must match the agent's permitted name. Unapproved custom names are suppressed, and configured icons are not forwarded unless the implementation's identity policy allows them. Do not add `chat:write.customize` merely to simulate separate agents; each agent already has its own app.

## 10. Troubleshooting

| Symptom | Check |
|---|---|
| No Slack startup | Selected primary conversation, both routed credentials, native WebSocket capability, and routing parse errors |
| App Messages tab cannot accept input | Messages tab enabled and read-only mode disabled |
| DMs fail while channels work | `message.im`, `im:history`, actual app/person DM ID, both route checks, trusted handle and `users:read` |
| Channel mention does nothing | Actual bot mention, app membership, subscribed event and effective scope, route and trust checks |
| Intermittent or wrong-agent messages | Shared app credentials, ownership conflict, or wrong agent environment |
| Reply leaves the thread | Inbound reply destination, outbound `--thread-ts`, and durable person/case mapping |
| File event without usable content | `files:read`, authorized file access, download host, size/count limits, and inbox error |
| Unauthorized input accepted | Loaded routing policy, exact identities, explicit handle list, and separate business authority |
| Reports repeat | Duplicate scheduler jobs or delivery through another transport |

Fix the specific missing setting or capability instead of broadening access to all people or channels. Restart and verify the affected path before claiming it is working.
