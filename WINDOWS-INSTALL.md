# AscendOps — Windows Install Guide

> **Read PRE-CALL-CHECKLIST.md first.** This guide assumes you've created the
> accounts and confirmed administrator rights. If you haven't, stop and do that —
> it's the difference between a 30-minute install and a 90-minute one.
>
> **Audience:** A Windows operator starting from zero. You may never have opened a
> terminal. Follow the steps in order; don't skip ahead.
>
> **Why a separate Windows guide?** The Mac install (SKOOL-INSTALL.md) is a couple
> of commands. Windows needs three extra things set up by hand — Node.js, Git, and
> the Visual C++ build tools — and the order matters. This guide walks each one.

---

## The one gotcha that explains half the Windows trouble

When you install a new tool on Windows (Node, Git, build tools), **the terminal you
already have open does not know about it yet.** It only sees tools that existed when
it started. So the rule is:

> **After installing anything, CLOSE every PowerShell window and open a fresh one.**

If a command says "not recognized" or "not installed" right after you installed it,
99% of the time the fix is: close PowerShell, open a new one, try again. (This is
exactly the "Git's still not installed, it doesn't make sense" loop that has burned
past installs — it was installed; the old window just couldn't see it.)

---

## Step 1 — Open PowerShell as Administrator

1. Press the `Windows` key, type **PowerShell**.
2. Right-click **Windows PowerShell** → **Run as administrator**.
3. If a "User Account Control" prompt appears, click **Yes**.

If you can't run as administrator (it's greyed out or asks for a password you don't
have), **stop here and get your IT person** — you can't install the tools without it.
This is the blocker from the pre-call checklist.

> Keep this Administrator window for the install steps. The title bar should say
> "Administrator: Windows PowerShell."

---

## Step 2 — Install Node.js (the engine)

AscendOps runs on Node.js. You need **version 20 or higher**.

1. Check what you have. In PowerShell, run:
   ```powershell
   node --version
   ```
   - If it prints `v20.x` or higher (e.g. `v22.x`), skip to Step 3.
   - If it says "not recognized" or a number below 20, install it next.

2. Go to **https://nodejs.org** and download the **LTS** installer (the big green
   button on the left). Run the downloaded `.msi`.

3. In the installer: click **Next** through the defaults, **accept the license**, and
   on the "Tools for Native Modules" screen **leave the checkbox UNCHECKED** — we
   install the build tools ourselves in Step 4 (the installer's automatic version is
   slow and unreliable). Finish the install.

4. **Close PowerShell, reopen it as Administrator** (the gotcha above), then confirm:
   ```powershell
   node --version
   ```
   You should now see `v20+`.

---

## Step 3 — Install Git (version control)

1. Check what you have:
   ```powershell
   git --version
   ```
   - If it prints a version, skip to Step 4.
   - If it says "not recognized", install it.

2. Go to **https://git-scm.com/download/win** — the download starts automatically
   (pick "64-bit Git for Windows Setup" if it doesn't). Run the installer.

3. Click **Next** through every screen — **the defaults are correct**. Don't overthink
   the options. Finish.

4. **Close PowerShell, reopen it as Administrator**, then confirm:
   ```powershell
   git --version
   ```
   You should now see a version number. If it still says "not recognized," you're
   almost certainly in an old window — open a brand-new PowerShell and try once more.

---

## Step 4 — Install the Visual C++ Build Tools

AscendOps uses a component (`node-pty`) that has to be compiled on your machine, and
that needs Microsoft's C++ build tools. This is the step that's unique to Windows.

In your **Administrator** PowerShell, run this single command:

```powershell
winget install Microsoft.VisualStudio.2022.BuildTools --override "--passive --wait --add Microsoft.VisualStudio.Workload.VCTools --includeRecommended"
```

- It downloads and installs in the background — give it a few minutes; it can look
  frozen but is working.
- If `winget` itself is "not recognized," update **App Installer** from the Microsoft
  Store, then retry. (Windows 10/11 both have winget once App Installer is current.)

> **Do NOT use the old `npm install -g windows-build-tools` command** you may see in
> older guides — it's deprecated and breaks on modern Node. The `winget` command above
> is the supported path.

When it finishes, the compiler lands in a spot that a normal PowerShell can't see yet.
So for the next step you'll open a **special** terminal:

- Press the `Windows` key, type **Developer PowerShell for VS 2022**, and open it
  **as Administrator** (right-click → Run as administrator).
- Use THIS window for the install in Step 6. It's the one that knows where the
  compiler lives.

---

## Step 5 — Install Claude Code and log in

Claude Code is the app the agents live inside. In the **Developer PowerShell for VS
2022** window:

```powershell
npm install -g @anthropic-ai/claude-code
claude login
```

`claude login` opens your browser to sign in with the Claude account from your
checklist. Approve it, then come back to the terminal.

> **About the Claude desktop app:** if a website nudges you to install the Claude
> *desktop app*, you don't need it for this — we use the command-line `claude`. The
> desktop app burns through your usage faster. Stick with the CLI.

---

## Step 6 — Run the AscendOps installer

Still in the **Developer PowerShell for VS 2022** (Administrator) window, run the
one-line installer:

```powershell
node -e "$(irm https://raw.githubusercontent.com/noogalabs/ascendops/main/install.mjs)"
```

This will:
- fork AscendOps into your GitHub account (so you get updates and can contribute back),
- clone it to `C:\Users\<you>\ascendops`,
- install dependencies and build the Visual C++ component from Step 4,
- and set everything up.

It takes several minutes. Let it run. If it stops on a build-tools error, double-check
you're in the **Developer PowerShell for VS 2022** window (not a plain PowerShell) —
that's the most common cause.

> **Already cloned it yourself?** If you forked and cloned AscendOps manually before
> the call, tell the installer where it lives instead of letting it clone again:
> ```powershell
> $env:ASCENDOPS_DIR = "C:\path\to\your\ascendops"
> node -e "$(irm https://raw.githubusercontent.com/noogalabs/ascendops/main/install.mjs)"
> ```
> Otherwise it installs fresh to `~\ascendops` and your manual clone just sits unused.

---

## Step 7 — Set up Telegram (phone first, then desktop)

Your agents talk to you through Telegram. Order matters:

1. **On your phone:** install the **Telegram** app and create your account with your
   phone number. Do this part first — the account lives on your phone.
2. **On your PC:** install **Telegram Desktop** from **https://desktop.telegram.org**.
3. **Link them:** open Telegram Desktop → it shows a **QR code** → on your phone, open
   Telegram → **Settings → Devices → Link Desktop Device** → point your phone camera at
   the QR code on your screen. Done — same account, both places.

You'll create one bot per agent during onboarding; the installer and the
SKOOL-INSTALL.md "Create a Telegram bot per agent" step walk you through that with
auto chat-ID capture.

---

## Step 8 — Keep the computer awake (24/7)

Your agents only run while this computer is on. Set Windows so it doesn't sleep:

1. Press `Windows` key, type **Power & sleep settings**, open it.
2. Set **Screen** and **Sleep** to **Never** while plugged in.
3. If it's a laptop: search **"Choose what closing the lid does"** → set **When I close
   the lid → Do nothing** (plugged in). Now you can close the lid and the agents keep
   running.
4. Leave it plugged in.

---

## Step 9 — Onboard your agents

Once the installer finishes and an agent sends you a "Booting up..." message on
Telegram, you're in **Phase 2**. From here the steps are the same on Windows as Mac —
follow **SKOOL-INSTALL.md → Phase 2 (Onboarding)**. In short: open each agent's
Telegram chat and send `/onboarding`, and it interviews you about your business, your
property-management software, and your style, then configures itself.

---

## Troubleshooting (Windows-specific)

| Symptom | Most likely cause | Fix |
|---|---|---|
| `node` / `git` / `claude` "not recognized" right after installing it | Old PowerShell window can't see the new tool | Close ALL PowerShell windows, open a fresh one, try again |
| "Access is denied" during install | Not running as Administrator, or no admin rights on this machine | Re-open PowerShell as Administrator; if blocked, get IT |
| Build fails on `node-pty` / "Visual C++ build tools required" | Running in a plain PowerShell, not the Developer one | Open **Developer PowerShell for VS 2022** (as Admin) and re-run Step 6 |
| `winget` "not recognized" | App Installer is out of date | Update **App Installer** in the Microsoft Store, retry |
| Installer cloned to `~\ascendops` but you wanted your own folder | `ASCENDOPS_DIR` not set | Set `$env:ASCENDOPS_DIR` to your folder before running (see Step 6 note) |
| Agents go quiet overnight | Computer slept or shut down | Re-check Step 8 power settings; keep it plugged in |

If you get stuck, copy the **exact** red error text from PowerShell and send it — the
specific wording is what tells us which step tripped.
