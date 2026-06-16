# AscendOps CLI Tools

Small connectors that let your AI agent work directly inside a piece of software — like Property
Meld or AppFolio — instead of you clicking through screens. Install one once, and your agent can
use it from then on.

This guide shows two things: how to **use** a tool, and how to **add your own**. No coding
background needed — if you can copy, paste, and follow a checklist, you can do both.

---

## The shelf

| Tool | Connects to | What it does | Install | Status |
|------|-------------|--------------|---------|--------|
| Property Meld | Property Meld | Read work orders, properties, and vendors; assign techs | `npx skills add noogalabs/ascendops --skill pm` | **Ready** |
| AppFolio | AppFolio | Read and act on AppFolio data from your agent | _coming soon_ | Coming soon |

A **Coming soon** tool isn't ready to install yet — check back later or ask in the community.

---

## Part A — How to use a tool

**The whole thing is: find it, run one command, set up your own credentials, done.**

1. **Find the tool** in the shelf table above. Look at the "Connects to" column.
2. **Copy its install command** from the "Install" column and run it in your terminal. For
   Property Meld:
   ```bash
   npx skills add noogalabs/ascendops --skill pm
   ```
   That adds the tool's skill to your agent.
3. **Install the tool itself.** The skill's page (`skills/pm/SKILL.md`) lists the one command that
   installs the actual CLI. For Property Meld:
   ```bash
   pipx install --include-deps git+https://github.com/noogalabs/cli-anything-pm.git
   ```
4. **Add your own credentials.** Every connector talks to *your* account, so it needs *your* login
   or API keys — nothing is shared or pre-filled. The skill's page tells you exactly which
   environment variables or files to set (for Property Meld: `PM_CLIENT_ID`, `PM_CLIENT_SECRET`,
   **and `PM_MULTITENANT_ID` set to your own Property Meld tenant id — required, or the CLI runs
   against the wrong account** — plus `playwright install chromium` for tech assignment).
5. **You're done.** Your agent can now use that tool.

> Installing the command is not the same as it working — a connector does nothing until you give it
> your own credentials. That step is always in the skill's own page.

---

## Part B — How to add your own tool

You (or someone helping you) built a connector for software your team uses, and you want to share
it. In the AscendOps model, **your tool lives inside this repo as its own folder** — you add the
folder, open a pull request, and once it's merged it's on the shelf for everyone who pulls.

> You are adding your tool's folder *into this repo* — not linking out to a separate repo. That way
> everything flows upstream to the maintainer for review, then downstream to everyone on pull.

### Step 1 — Add your skill folder

Create `skills/<your-tool>/SKILL.md`. Copy `skills/pm/SKILL.md` as a template and change the
content. The frontmatter at the top must include:

```yaml
---
name: <your-tool>
description: "One sentence on what the tool does and when to use it."
user-invocable: false
---
```

`name` is what members type after `--skill`. Keep each value on its own line with
**no inline `#` comments** — the framework reads these keys literally, so a trailing
comment (e.g. on `user-invocable: false`) would be read as part of the value and
break the opt-out.

> **Always include `user-invocable: false`.** Your tool is something members opt
> into with `npx skills add`, not a built-in command. Without this line, the
> framework would auto-register your tool as a global `/<name>` Telegram command
> on **every** AscendOps bot after an upgrade — even ones that never installed it.
> The line keeps your tool installable while staying out of everyone's command menu.

The body should cover: the one command to **install** the underlying CLI, the **credentials** the
user must set themselves, and the **commands** the tool provides.

### Step 2 — Add a row to the shelf table

Open `CLI-TOOLS.md`, find the shelf table near the top, and add one row for your tool — copy an
existing row and change the words. Fill in: Tool, Connects to, What it does, the
`npx skills add noogalabs/ascendops --skill <your-tool>` install command, and Status (`Ready` or
`Coming soon`).

### Step 3 — Open a pull request

Commit your new `skills/<your-tool>/` folder and the table row on a branch, then open a pull
request titled like **"Add <your-tool> to the shelf."** An AscendOps maintainer reviews it and
merges. Your tool now shows up for everyone.

---

### A few friendly notes

- **One tool per pull request** — it keeps things easy to review.
- **Only share what's safe to be public.** Passwords and keys belong in the *user's* own setup,
  never written into the tool or this repo. If unsure, ask in the community before sharing.
- **Stuck?** Drop a note in the AscendOps Skool community — someone will walk you through it.

Welcome to the shelf — glad to have your tool on it.
