---
name: onboarding
description: "You have just booted for the first time — there is no .onboarded flag in your state directory — and you need to set up your identity, connect your Telegram bot, configure your goals, and establish yourself within the org. Or onboarding was previously interrupted and the user has asked you to run it again. This skill walks you through every step of becoming a functioning agent. Do not skip steps. Do not start normal operations until onboarding is complete."
triggers: ["onboarding", "/onboarding", "first boot", "run onboarding", "setup", "not onboarded", "configure agent", "set up identity", "establish identity", "set goals", "onboard me", "start onboarding", "redo onboarding", "onboarding interrupted", "first time setup", "initial setup", "agent setup"]
external_calls: ["api.telegram.org", "raw.githubusercontent.com"]
---

# Onboarding

This skill runs on first boot or when explicitly triggered. It is the only thing you should do until it is complete.

---

## Step 0: Bootstrap orientation (Phase 1 — for operators starting from zero)

The full, doc-independent zero-to-fleet install sequence lives locally at
`SKOOL-INSTALL.md` in the AscendOps project root (delivered by a successful
install — do NOT rely on any external/Skool link, which may render blank). If the
operator hasn't completed bootstrap, point them there. The two phases:

- **Phase 1 — Bootstrap (must be done before this skill matters):** create prereq
  accounts (GitHub, Anthropic/Claude, Google, Telegram, optional Telnyx) → install
  Claude Code (`npm install -g @anthropic-ai/claude-code` + `claude login`) → run
  the installer (`curl -fsSL https://raw.githubusercontent.com/noogalabs/ascendops/main/install.mjs | node`)
  → open `~/ascendops` in Claude Code → create a Telegram bot per agent with auto
  chat_id capture (below).
- **Phase 2 — Onboarding (this skill):** configure the agent for the operator's PM
  business + software.

**Agent order is data-driven:** EA/orchestrator FIRST (it coordinates the rest),
THEN the required core agents, THEN the optional
agents. Follow the ordered roster table in `SKOOL-INSTALL.md` top-to-bottom; create
+ onboard each required agent before any optional one.

### Bot setup walkthrough (baked in here so it works even if SKOOL-INSTALL.md is missing)

For THIS agent, if its `.env` has no `BOT_TOKEN`/`CHAT_ID` yet:

1. In Telegram, message **@BotFather** → `/newbot` → pick a display name → pick a
   username ending in `bot`. Copy the **BOT_TOKEN** it returns (looks like
   `123456789:AA...`).
2. Auto-capture the chat_id (no manual hunting) — run:
   ```bash
   cortextos detect-chat-id --agent "$CTX_AGENT_NAME" --org "$CTX_ORG"
   ```
   Paste the token when asked, then **send `/start` to the bot `@username` it
   prints**. It captures `CHAT_ID` + `ALLOWED_USER` the moment you message the bot
   and writes `BOT_TOKEN`/`CHAT_ID`/`ALLOWED_USER` into this agent's `.env`
   (chmod 600). It times out cleanly if you wait too long — just re-run it.
   (Interactive alternative: `cortextos bot create "$CTX_AGENT_NAME"`.)

Only after the bot is wired does the rest of onboarding (below) run.

### Optional AscendOps support access

Ask the operator whether they want to enable AscendOps support access for this
agent so the owner can help through the agent's Telegram bot. Default to **No**. If
they choose yes, run:

```bash
cortextos support-access enable --agent "$CTX_AGENT_NAME" --org "$CTX_ORG"
```

Show the command output, including the share-instruction for the owner. If they choose
no, continue onboarding and note they can enable or disable it later with
`cortextos support-access`.

---

## Step 1: Check onboarding status

```bash
[[ -f "${CTX_ROOT}/state/${CTX_AGENT_NAME}/.onboarded" ]] && echo "ONBOARDED" || echo "NEEDS_ONBOARDING"
```

If already `ONBOARDED`, skip to normal session start. Do not re-run onboarding unless the user explicitly requests it.

---

## Step 2: Read ONBOARDING.md

```bash
cat ONBOARDING.md
```

This file contains the full onboarding protocol for your specific agent role. Follow every step exactly. Do not improvise.

---

## Step 3: What onboarding establishes

Onboarding must complete all of the following before you are considered functional:

| Item | File written |
|------|-------------|
| Your name, role, emoji, and identity | `IDENTITY.md` |
| Your behavior, autonomy rules, and mode | `SOUL.md` |
| Your current goals and focus | `GOALS.md` |
| User preferences and context | `USER.md` |
| Guardrails and patterns to avoid | `GUARDRAILS.md` |
| Telegram bot connected and tested | `.env` (BOT_TOKEN, CHAT_ID) |
| Crons configured and running | `config.json` |
| Knowledge base ingestion rules set | `.claude/skills/memory-management/SKILL.md` |
| KB initial ingestion done | `cortextos bus kb-ingest` |
| Migration from previous agent (if applicable) | memory files copied |
| Autoresearch cycle offered | `experiments/config.json` (optional) |
| .onboarded flag written | `$CTX_ROOT/state/$CTX_AGENT_NAME/.onboarded` |

---

## Step 4: Mark complete

When all steps in ONBOARDING.md are done:

```bash
mkdir -p "$CTX_ROOT/state/$CTX_AGENT_NAME"
touch "$CTX_ROOT/state/$CTX_AGENT_NAME/.onboarded"
```

Then notify the user via Telegram that you are online and ready.

---

## Persistent crons

Any recurring workflow you set up during onboarding (heartbeats, sweeps, reports) must be a PERSISTENT cron so it survives restarts: create it with `cortextos bus add-cron`, never `/loop` (which is session-only and dies on restart; Codex-runtime agents have no `/loop` at all). The daemon reschedules every entry in `crons.json` on each start. See the persistent-cron section of `ONBOARDING.md` for full setup and examples.

---

## If Onboarding Is Interrupted

If a session crash or restart interrupts onboarding mid-way:

1. Check which steps completed (look at which files exist)
2. Resume from the first incomplete step
3. Do NOT restart from the beginning if some steps already completed
4. Re-run `/onboarding` if needed to trigger this skill again

---

## Critical Rules

- Do NOT send a Telegram message claiming you are online until onboarding is complete
- Do NOT set up crons until IDENTITY.md and GOALS.md are written
- Do NOT start processing user requests until `.onboarded` is written
- The user is waiting — be efficient, but do not skip steps
