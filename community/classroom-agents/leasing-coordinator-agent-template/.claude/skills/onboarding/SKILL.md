---
name: onboarding
description: "You have just booted for the first time (there is no .onboarded flag in your state directory) and you need to set up your identity, connect your Telegram bot, configure your goals, capture how the operator runs their business, and start running their work. Or onboarding was interrupted and the user asked you to run it again. This skill walks you through becoming a functioning agent by INTERVIEWING the operator (you ask, they answer) and writing the answers into your own config. Do not skip steps. Do not start normal operations until onboarding is complete."
triggers: ["onboarding", "/onboarding", "first boot", "run onboarding", "setup", "not onboarded", "configure agent", "set up identity", "establish identity", "set goals", "onboard me", "start onboarding", "redo onboarding", "onboarding interrupted", "first time setup", "initial setup", "agent setup"]
---

# Onboarding

This skill runs on your FIRST BOOT or when explicitly triggered. It is the only thing you should do until it is complete. It is a reverse-prompting interview: YOU ask the operator questions over Telegram, and you write their answers into your own configuration. The operator does not hand-edit files; you do it for them from the conversation.

---

## Step 0: Make sure your Telegram bot is wired

This interview happens over Telegram, so your bot must be connected first. If this agent's `.env` has no `BOT_TOKEN`/`CHAT_ID` yet:

1. In Telegram, message **@BotFather**, send `/newbot`, pick a display name, then a username ending in `bot`. Copy the **BOT_TOKEN** it returns (looks like `123456789:AA...`).
2. Capture the chat id without manual hunting:
   ```bash
   cortextos detect-chat-id --agent "$CTX_AGENT_NAME" --org "$CTX_ORG"
   ```
   Paste the token when asked, then send `/start` to the bot username it prints. It writes `BOT_TOKEN`/`CHAT_ID`/`ALLOWED_USER` into this agent's `.env` (chmod 600) the moment you message the bot. It times out cleanly, just re-run it. (Interactive alternative: `cortextos bot create "$CTX_AGENT_NAME"`.)

IMPORTANT: if you just wrote your Telegram credentials with `detect-chat-id` in THIS session, the daemon loaded your `.env` when it spawned you, so it will not receive the operator's Telegram replies until it reloads. Restart now so the interview can hear the operator:
```bash
cortextos bus self-restart --reason "loaded Telegram credentials, restarting to pick them up"
```
Onboarding resumes automatically on the next boot (the `.onboarded` flag is still absent, so this skill fires again and the interrupted-onboarding section below picks up where you left off). If the operator set `BOT_TOKEN`/`CHAT_ID` in `.env` BEFORE they started you (the recommended path), skip this restart, your credentials are already live.

Only after the bot is wired AND its credentials are live does the rest of onboarding run.

---

## Step 1: Check onboarding status

```bash
[[ -f "${CTX_ROOT}/state/${CTX_AGENT_NAME}/.onboarded" ]] && echo "ONBOARDED" || echo "NEEDS_ONBOARDING"
```

If already `ONBOARDED`, skip to normal session start. Do not re-run onboarding unless the user explicitly asks.

---

## Step 2: Read ONBOARDING.md and run the interview

```bash
cat ONBOARDING.md
```

`ONBOARDING.md` is the interview script for your specific role. Follow it in order: you greet the operator, explain briefly how you work, then ask the questions it lists one topic at a time, and write each answer into your config as you go. Do not improvise the questions; do not dump them all at once.

---

## Step 3: What the interview establishes

You are not done until all of these are written from the operator's answers:

| Item | Where it goes |
|------|-------------|
| Your name, role, and identity | `IDENTITY.md` (replace the `<!-- onboarding -->` markers and `{{placeholders}}`) |
| Company / owner / operator / timezone | `IDENTITY.md`, `USER.md`, `SYSTEM.md`, `config.json` |
| Behavior, autonomy posture (copilot-first) | `SOUL.md` |
| Goals and current focus | `GOALS.md`, `goals.json` |
| The operator's business shape + software stack | `SYSTEM.md` |
| The operator's SOPs / rules / preferences | a knowledge file you ingest to the KB so you operate THEIR way |
| Telegram bot connected and tested | `.env` |
| Recommended role crons added | `config.json` via `cortextos bus add-cron` (final step, see ONBOARDING.md) |
| `.onboarded` flag written | `$CTX_ROOT/state/$CTX_AGENT_NAME/.onboarded` (written ONLY by ONBOARDING.md's final block, after the crons, see Step 4) |

---

## Step 4: Mark complete (single authority: ONBOARDING.md's final step)

There is exactly ONE place that writes `.onboarded`: the final block in `ONBOARDING.md` (its "Finalize and add the recommended crons" step). Do NOT write `.onboarded` from this skill or by hand. That block is the single completion authority, and it does three things in order: (1) the final placeholder-and-marker sweep, a hard gate that refuses to finish while any `{{...}}` placeholder or the unfilled `## Name` marker remains anywhere across your bootstrap files, `CLAUDE.md`, and every `.claude/skills/**/SKILL.md`; (2) registers your recommended role crons; and (3) only THEN writes `.onboarded`, `&&`-chained after the crons so that if a cron fails to register, `.onboarded` is not written.

This single-writer rule is load-bearing. If `.onboarded` were ever written before the crons, or by a second path that skips them, you would end up onboarded WITHOUT your role crons, and the `.onboarded` flag suppresses re-onboarding, so the crons would never get added. So do not duplicate the completion here: finish by running ONBOARDING.md's final block, and let that block be the thing that writes `.onboarded`.

Only after that block writes `.onboarded` (placeholders clean AND crons registered) are you done. Then send the operator a Telegram message that you are online, configured, and running in copilot mode.

---

## If onboarding is interrupted

If a crash or restart interrupts onboarding mid-way:

1. Check which steps completed (which files were written).
2. Resume from the first incomplete step.
3. Do NOT restart from the beginning if some steps already completed.
4. Re-run `/onboarding` if needed to trigger this skill again.

---

## Critical rules

- Do NOT tell the operator you are online until onboarding is complete.
- Do NOT add crons until IDENTITY.md and GOALS.md are written from the interview.
- Do NOT start processing real work until `.onboarded` is written.
- You operate copilot-first throughout: you draft and propose, the operator approves, and nothing external or money-moving goes out without their approval.
- The operator is waiting: be efficient, ask one topic at a time, but do not skip steps.
