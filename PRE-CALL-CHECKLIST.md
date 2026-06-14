# AscendOps — Pre-Call Checklist (send before any setup call)

Do these **before** your setup call. Every item you finish ahead of time turns a
90-minute call into a 30-minute one. The two starred items (★) are the ones that
have actually blocked installs mid-call — please don't skip them.

## Accounts to create (all have free signups)

- [ ] **GitHub** — https://github.com/signup
- [ ] **Anthropic / Claude** — https://claude.ai  ★ **see subscription note below**
- [ ] **Google** — any free Google account (powers the knowledge base)
- [ ] **Telegram** — install it on your **phone first**, then we'll add desktop on the call

## ★ Claude subscription tier (this matters for cost)

You need a **paid Claude subscription**, and the tier you pick changes what it costs to run:

- **$20 plan** — too small. You'll hit rate limits with even one agent. Do not rely on this.
- **$100 plan** — the minimum to run a small fleet.
- **$200 plan** — recommended. Runs 5–10 agents comfortably.

Use a **personal Claude subscription**, NOT a "team member" plan and NOT API tokens.
The whole system is built to run inside your personal subscription. Going the API-token
route costs roughly 5–10× more — think $2,000–$5,000/month instead of $200. Stay on the subscription.

## ★ Administrator rights on your computer

The installer has to install developer tools (Node.js, Git, build tools) that
**require local administrator access**. On a personal machine you already have this.
**On a work/company machine you very likely do not** — and "access denied" mid-install
is the #1 thing that has stopped a call cold.

- [ ] Confirm you can install software on this computer, **or**
- [ ] Loop in your IT person **before** the call so they can grant access or sit in.

## Always-on requirement

Your agents run **on your computer**, so it needs to stay **on 24/7**. If the computer
sleeps or shuts down, your agents go offline.

- [ ] Plan to leave this machine on and plugged in. (On the call we'll set Windows so
      closing the lid / idle time doesn't put it to sleep.)

## Quick machine check

- [ ] **RAM: 16 GB minimum.** To check on Windows: press `Windows key`, type
      **"View RAM info"**, open it, look at "Installed RAM."

## For the call itself

- [ ] Be ready to **share your entire screen** (not just one browser tab) — we switch
      between the terminal, browser, and Telegram.

---

**Windows users:** after this checklist, follow **WINDOWS-INSTALL.md** for the
step-by-step install. **Mac users:** follow **SKOOL-INSTALL.md**.
