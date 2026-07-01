# AscendOps — Zero-to-Fleet Install Guide

> **This is the delivered install guide.** A successful install lands this exact
> file locally at `~/ascendops/SKOOL-INSTALL.md`. If you reached it via a link
> that rendered blank, ignore that copy and read this local one — the critical
> steps also live inside each agent's `/onboarding` skill, so the install works
> even if every external link is dead.
>
> **Audience:** A property-management operator starting from ABSOLUTE ZERO — you
> may never have opened a terminal or used Claude Code. This guide takes you from
> nothing to a running agent fleet that texts you on Telegram.
>
> **Two phases, in order:**
> - **Phase 1 — Bootstrap.** Get the machinery installed and one agent talking to
>   you. Fast and foolproof. This is the part that historically tripped people up;
>   follow it step by step and you will reach Phase 2.
> - **Phase 2 — Onboarding.** Each agent interviews you about your business, your
>   PM software, your vendors, and your style, then configures itself. This is
>   where the real value is.
>
> **Time:** ~30 min if you already have the accounts in Step 1.1, ~60–90 min if
> you need to create them.

---

# PHASE 1 — BOOTSTRAP (absolute zero → first agent online)

Do these in order. Do not skip ahead.

## Step 1.1 — Create the prerequisite accounts

You need these accounts before anything else. Create any you don't have (all have
free tiers):

- [ ] **GitHub** — [github.com/signup](https://github.com/signup). The installer
      forks AscendOps into your account so you get our updates and can send your
      improvements back.
- [ ] **Anthropic / Claude** — [claude.ai](https://claude.ai) or
      [console.anthropic.com](https://console.anthropic.com). This is the brain
      that runs every agent. A Claude subscription (Pro/Max) that lets you log in
      via the `claude` CLI is the easiest; an `ANTHROPIC_API_KEY` also works.
- [ ] **Google** — a free Google account. Powers the knowledge base (semantic
      search) via a free Gemini API key you'll create during onboarding at
      [aistudio.google.com/apikey](https://aistudio.google.com/apikey).
- [ ] **Telegram** — install the Telegram app and create an account. This is how
      you'll talk to your agents. You'll create one bot per agent in Step 1.5.
- [ ] **(Optional) Telnyx** — [telnyx.com](https://telnyx.com). Only if you want
      agents to send SMS / place voice calls to vendors and tenants. Skip for
      day one; you can add it later.

## Step 1.2 — Install Claude Code

Claude Code is the command-line app the agents run inside. You almost certainly
don't have it yet — install it now.

**First, make sure you have Node.js 20+.** Open a terminal (on Mac: Cmd+Space →
"Terminal"; on Linux: your terminal app) and run:

```bash
node --version
```

- If it prints `v20.x` or higher, you're set.
- If it prints a lower version or "command not found", install Node from
  [nodejs.org](https://nodejs.org/) (the LTS download) and re-check.

**Then install Claude Code and log in:**

```bash
npm install -g @anthropic-ai/claude-code
claude login
```

`claude login` opens your browser to authenticate with your Anthropic/Claude
account from Step 1.1. Do this once.

**(Recommended) install the GitHub CLI** so the installer can fork the repo for
you (enables sending improvements back upstream):

```bash
# macOS:
brew install gh && gh auth login
# Linux: see https://cli.github.com for the install command, then: gh auth login
```

Without `gh`, the install still works — you'll just be on a plain clone (pull-only)
until you set up a fork later.

## Step 1.3 — Run the installer (one command)

Copy-paste this single line into your terminal:

```bash
curl -fsSL https://raw.githubusercontent.com/noogalabs/ascendops/main/install.mjs | node
```

> **Not comfortable in the terminal?** Paste this whole guide into Claude or
> ChatGPT and ask it to walk you through each step — it has everything it needs.

The installer:
- Forks + clones AscendOps to `~/ascendops` (or plain-clones if `gh` isn't authed).
  Override the location with `ASCENDOPS_DIR=/some/path` if you want it elsewhere.
- Runs `npm install` and `npm run build` to compile.
- Links the `cortextos` CLI into your PATH and installs PM2 (the process manager).
- A successful clone delivers this very file to `~/ascendops/SKOOL-INSTALL.md` and
  the `/onboarding` skill into each template — so the rest of the install never
  depends on an external link.

When it finishes you'll see **"AscendOps installed successfully!"** and a
copy-paste command to launch onboarding.

## Step 1.4 — Open the installed folder in Claude Code

The installer prints this exact command — run it:

```bash
cd ~/ascendops && claude /onboarding
```

This opens Claude Code in the AscendOps folder with the onboarding wizard already
starting. (If the auto-launch didn't fire, run the command above yourself.)

## Step 1.5 — Create a Telegram bot per agent (with auto chat_id capture)

Each agent talks to you through its own Telegram bot. This used to be the single
most error-prone step (manually hunting for a numeric "chat id"). It is now
automated — **you never copy a chat id by hand.**

You'll repeat this short loop once per agent, in the order Phase 2 lays out
(EA/orchestrator first). For each agent:

**a. Create the bot at @BotFather.**
1. In Telegram, open a chat with **@BotFather**.
2. Send `/newbot`.
3. Give it a display name (e.g. "Acme Maintenance Coordinator").
4. Give it a username ending in `bot` (e.g. `acme_md_bot`).
5. BotFather replies with a **BOT_TOKEN** that looks like `123456789:AA...`. Copy it.

**b. Let AscendOps capture the chat id automatically.** In your terminal, run:

```bash
cortextos detect-chat-id --agent <agent-name> --org <your-org>
```

It will:
- Ask you to paste the BOT_TOKEN (or pass `--token <token>`).
- Verify the token and print the bot's `@username`.
- Wait for you to message the bot. **Open Telegram, search the `@username` it
  printed, and send `/start`.**
- The moment your message lands, it captures the chat id + your user, writes
  `BOT_TOKEN`, `CHAT_ID`, and `ALLOWED_USER` into that agent's `.env` (chmod 600),
  and tells you the agent is ready to start.

If you wait too long or messaged the wrong bot it times out cleanly with a clear
message — just re-run it. (The same flow is also available as the interactive
`cortextos bot create <agent-name>` if you prefer one combined walkthrough.)

That's the bootstrap. Every agent now has a bot and a captured chat id. On to the
real value.

---

# PHASE 2 — ONBOARDING (configure each agent for YOUR business)

This is what the install is *for*. Each agent runs a question-driven `/onboarding`
that configures it for your company, your PM software, your vendors, and your
communication style. The Phase-1 bootstrap exists only to get you here.

## Step 2.1 — The agent roster (ordered)

Agents come up in a deliberate order: the **EA / orchestrator first** (it
coordinates the others), then the **required core agents**, then **optional**
agents you can add or skip. The roster is data-driven so the exact lineup can
change without changing the install steps — work down the list top to bottom and
**create + onboard each required agent before moving to optional ones.**

> **Roster (LOCKED 2026-06-02):** 6 personas — 4 required, 2 optional. Work the
> table top to bottom; bring up every **required** agent before any **optional**
> one. The list is data-driven, so the lineup can change later without changing
> these steps.

| Order | Agent | Template | Required? | Role |
|-------|-------|----------|-----------|------|
| 1 | EA / Orchestrator | `orchestrator` | **required** | Coordinates the fleet; your single point of contact |
| 2 | Maintenance Coordinator | `maintenance-coordinator` | **required** | Work-order triage, vendor dispatch, resident comms |
| 3 | Analyst | `analyst` | **required** | Metrics, reporting, and fleet/data analysis |
| 4 | Dev | `agent` | **required** | Builds + reviews code changes for your fleet (Claude Code) |
| 5 | Second Dev (Codex) | `agent-codex` | optional | A second build agent on the Codex runtime |
| 6 | Leasing Coordinator | `leasing-coordinator` | optional | Leasing pipeline: intake, showings, applications, move-in. **Newer — built + defined but not yet production-proven; the Maintenance Coordinator is the proven PM persona.** |

The wizard reads this ordering and walks you through it. The rule it follows:
**EA/orchestrator → required core agents → optional agents.** If you skip an
optional agent now, you can add it later with the same two steps (create, then
onboard).

> **PM software is a Phase-2 choice, not an install dependency.** The Maintenance
> Director (and Leasing Coordinator) ship as personas no matter which property
> software you run. You bind your PM software — **Property Meld** today, more
> adapters coming, or **none** — during that agent's `/onboarding` (Phase 2), not
> during this install. The agents come up and work without any PM software wired.

## Step 2.2 — For each agent, in order: create → bot → onboard

For every agent in the roster (top to bottom, required before optional):

1. **Create it** (skip if the wizard already did):
   ```bash
   cortextos add-agent <agent-name> --template <template> --org <your-org>
   ```
   Confirm you see `Copied template files from <template>` (not
   `Created minimal agent files` — that means the template wasn't on disk; run
   `git pull upstream main` and retry).

2. **Wire its Telegram bot** using the Phase-1 Step 1.5 loop
   (`cortextos detect-chat-id --agent <agent-name> --org <your-org>`).

3. **Start it and run its onboarding:**
   ```bash
   cortextos start <agent-name>
   ```
   "Booting up..." lands in that bot's Telegram chat within ~5–15s. Then, in that
   Telegram chat, send:
   ```
   /onboarding
   ```
   Answer its questions (5–10 min each). It writes its `IDENTITY.md`, `GOALS.md`,
   `USER.md`, `GUARDRAILS.md`, sets up crons, and marks itself onboarded.

Do the EA/orchestrator first so it can coordinate the rest, then the required PM
personas, then any optional agents.

## Step 2.3 — Verify the fleet

Message each agent:

> "Morning. What's on your plate today?"

Each should reply with a short status reflecting what onboarding configured — the
Maintenance Coordinator mentions work orders / vendors, the Leasing Coordinator
mentions prospects / showings, the orchestrator gives a fleet-level pulse. You can
also run:

```bash
cortextos status
```

If everything is green and the agents reply on Telegram, you have a running fleet.

---

# Add-ons (after the fleet is up)

## Tirith — terminal + agent safety (recommended)

A safety layer that inspects every command before it runs. AGPL-3.0, so we can't
bundle it — one-step install:

```bash
brew install sheeki03/tap/tirith
echo 'eval "$(tirith init --shell zsh)"' >> ~/.zshrc
source ~/.zshrc
tirith doctor   # should report: hook status: CONFIGURED
```

bash/fish + full reference: [github.com/sheeki03/tirith](https://github.com/sheeki03/tirith). Default mode is warn-only.

## Slack

Just message your orchestrator agent on Telegram: "Help me set up Slack." It walks
you through workspace + app creation, OAuth scopes, token paste, and channel pick
(~10 min). Your Slack token stays on your machine.

## What to skip on day one

- **PM software integration** (Property Meld / AppFolio) — agents work without it.
  See [README.envs.md](./README.envs.md) for the credential variables.
- **Telnyx (voice + SMS)** — add when you want vendor/tenant outbound.
- **Cloudflare R2 (photo storage)** — only matters once tenants upload photos.
- **Knowledge base ingestion** — agents run on built-in memory until you ingest
  your own docs.

---

# How updates and improvements flow

Check which path you're on:

```bash
cd ~/ascendops && git remote -v
```

- **You see both `origin` (your fork) and `upstream` (noogalabs/ascendops):** the
  installer forked for you. Two-way flow:
  - Pull our updates: `git pull upstream main`
  - Send yours back:
    ```bash
    git checkout -b feat/my-improvement
    # edits...
    git push origin feat/my-improvement
    gh pr create --repo noogalabs/ascendops --base main
    ```
- **You see only `upstream`:** plain-clone (pull-only) — `gh` wasn't authed at
  install. Pull updates with `git pull upstream main`. To enable contributing back:
  ```bash
  cd ~/ascendops
  gh auth login            # if you haven't
  gh repo fork noogalabs/ascendops --remote
  ```

The persona templates, PM integrations, and skills were built by operators with
real businesses. AscendOps gets better as you do.

---

# Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| `curl` install fails (HTTP error) | Network / rate limit | Wait a minute, retry. Or clone manually: `git clone https://github.com/noogalabs/ascendops.git ~/ascendops` then `node ~/ascendops/install.mjs` |
| `claude: command not found` | Claude Code not installed | `npm install -g @anthropic-ai/claude-code` then `claude login` (Step 1.2) |
| `node: command not found` or version < 20 | Node.js missing/old | Install Node LTS from [nodejs.org](https://nodejs.org/) (Step 1.2) |
| Installer says "gh installed but not authed" | No `gh auth login` | Run `gh auth login`, or accept the plain-clone fallback (fork later) |
| `/onboarding` does nothing in Claude Code | Not at the project root | `cd ~/ascendops` then `claude .` |
| `detect-chat-id` / bot setup times out | You didn't `/start` the bot, or messaged the wrong one | Re-run it; send `/start` to the exact `@username` it prints, from your own account (not a channel/bot) |
| Agent starts but never messages Telegram | Wrong BOT_TOKEN / CHAT_ID | Re-run `cortextos detect-chat-id --agent <name>`; confirm with `cortextos status` |
| `add-agent` says "Created minimal agent files" | Template not on disk (fork behind upstream) | `git pull upstream main`, then re-run `add-agent` |
| Agent boots but `/onboarding` does nothing | `.onboarded` already exists from a prior attempt | `rm ~/.cortextos/default/state/<agent-name>/.onboarded` and retry |

For anything else: check `~/.cortextos/default/logs/<agent>/stderr.log` and run
`cortextos bus read-all-heartbeats`. The Skool community is the place to ask.

---

# Advanced — manual install (for developers)

If you want to read the source as you go, customize the install path, or
troubleshoot a failed step by hand, the manual path produces the identical end
state. Briefly:

```bash
gh repo fork noogalabs/ascendops --clone --remote   # origin=fork, upstream=canonical
cd ascendops && npm install && npm run build
node dist/cli.js --version                            # verify CLI
node dist/cli.js init <your-org>                      # create your org
# then, per agent in the Phase-2 roster order:
node dist/cli.js add-agent <name> --template <template> --org <your-org>
node dist/cli.js detect-chat-id --agent <name> --org <your-org>   # auto chat_id
node dist/cli.js start <name>
# then /onboarding in each agent's Telegram chat
```

Everything Phase 1 + Phase 2 above describes maps onto these commands; the wizard
just runs them for you in order. Org secrets live in `orgs/<org>/secrets.env` and
the activity-channel bot creds in `orgs/<org>/activity-channel.env` (both chmod
600); the onboarding wizard fills these in.

---

# Appendix — what got installed

- `~/.cortextos/default/` — daemon state, logs, inbox/outbox, agent state. Per-instance.
- `~/ascendops/orgs/<org>/` — your org config, secrets, agent dirs. Secrets gitignored.
- `node_modules/` — npm deps (gitignored; ~2 min to recreate).
- PM2 — runs the daemon and agents (`pm2 list`).

No system files outside `~/.cortextos/` and `~/ascendops/`. Uninstall is `rm -rf`
on those two locations.
