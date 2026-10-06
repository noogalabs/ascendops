---
name: pm-session-recapture
effort: medium
description: "When pm probe returns 401/403 (session expired), automatically recapture PropertyMeld session cookies. macOS agents use the AX+CDP script; Linux/cloud agents use the Playwright headless script."
triggers: ["pm session expired", "pm probe 401", "pm probe failed", "session recapture", "cookies expired", "recapture pm session", "pm auth broken"]
---
## Member Role Bindings

Before applying this skill, read the member organization configuration and bind
`<maintenance-owner>` to its escalation/approval owner and approved contact route,
`<maintenance-agent>` to its maintenance agent, and `<orchestrator-agent>` to its
coordinator. Use `CTX_ORCHESTRATOR_AGENT` for executable bus examples and
`CTX_AGENT_NAME` for the running agent's paths. Resolve vendor and in-house
technician placeholders from the same member configuration. If a required role
is missing or ambiguous, ask the configured coordinator before dispatch; never
substitute a person, agent or chat ID from an example. Existing emergency and
approval rules still govern actions.


# PM Session Recapture

Automated recovery when PropertyMeld session cookies expire. Two implementations — pick based on your platform:

| Platform | Script | How it works |
|----------|--------|--------------|
| **macOS (preferred)** | `scripts/pm-recapture-session-safari.py` | SafariDriver reads live Safari session — no Chrome, lower RAM |
| **macOS (Chrome fallback)** | `scripts/pm-recapture-session.py` | Drives Chrome via osascript + CDP |
| **Linux / cloud** | `scripts/pm-recapture-session-playwright.py` | Headless Chromium via Playwright |

All scripts require `PM_WEB_EMAIL` and `PM_WEB_PASSWORD` (or interactive prompt). All write the same cookie format to `PM_CREDS_PATH`.

Safari is preferred on Mac — it uses the native browser you are already running and needs no extra process.

---

## When to Run

Run when ANY of:
-  returns non-OK status (401, 403, or )
- Any snapcli command returns 401/403 on a normally working operation
- <maintenance-agent> receives a comms-boundary escalation message about PM session death
- the configured orchestrator explicitly requests session refresh

Do NOT run if:
- Nexus API (OAuth2) is the failing component — that has its own credentials and does not use cookies
- The PM site itself is down (check propertymeld.com status first)

---

## Prerequisites

- PM_WEB_EMAIL and PM_WEB_PASSWORD must be set in the agent's .env
- Google Chrome must be installed at 
- Accessibility permission must be granted to Terminal/iTerm (System Settings → Privacy → Accessibility)
- macOS only

---

## Step 1 — Verify the session is actually expired

```bash
pm probe --json
```

If status is ok: stop. No recapture needed.

If status is error/401/403: proceed.

---

## Step 2 — Run the recapture script

**macOS (Safari — preferred, lower RAM):**
```bash
# One-time setup:
#   Open Safari → Develop → Allow Remote Automation
#   pip install selenium
PM_WEB_EMAIL="$PM_WEB_EMAIL" PM_WEB_PASSWORD="$PM_WEB_PASSWORD" python3 scripts/pm-recapture-session-safari.py
```

**macOS (Chrome fallback):**
```bash
PM_WEB_EMAIL="$PM_WEB_EMAIL" PM_WEB_PASSWORD="$PM_WEB_PASSWORD" python3 scripts/pm-recapture-session.py
```

**Linux / cloud (requires `pip install playwright && playwright install chromium`):**
```bash
PM_WEB_EMAIL="$PM_WEB_EMAIL" PM_WEB_PASSWORD="$PM_WEB_PASSWORD" python3 scripts/pm-recapture-session-playwright.py
```

All scripts are in `adapters/pm/scripts/` in noogalabs/snapcli.

Script will:
1. Launch Chrome with  if not already running with it
2. Navigate to PM login via osascript
3. Fill credentials and submit via JS injection
4. Wait for post-login redirect
5. Extract cookies via CDP
6. Write cookies to 
7. Re-probe to confirm session is live

**Expected output on success:**
```
Checking existing PM session...
Session expired. Starting recapture via Chrome AX + CDP...
Chrome CDP available on port 9222
Login successful — extracting cookies via CDP...
Extracted N propertymeld.com cookies
Wrote cookies to ~/.claude/credentials/property-meld.json
Recapture verified — PM session is now active.
```

---

## Step 3 — Log and notify

On success:
```bash
cortextos bus log-event action pm_session_refreshed info \
  --meta '{"method":"ax-cdp","creds_path":"~/.claude/credentials/property-meld.json"}'
cortextos bus send-message "$CTX_ORCHESTRATOR_AGENT" normal 'PM session recaptured via AX+CDP. Snapcli operations restored.'
```

On failure (script exits 1):
```bash
cortextos bus log-event action pm_session_recapture_failed warning \
  --meta '{"method":"ax-cdp","reason":"script exit 1"}'
# Escalate immediately — human must intervene
cortextos bus send-message "$CTX_ORCHESTRATOR_AGENT" urgent 'PM session recapture FAILED. Manual intervention required. PM_WEB_EMAIL/PASSWORD may be wrong, PM may have changed login flow, or Accessibility permission may be missing.'
```

---

## Comms Boundary

If recapture fails, this is a hard escalation to the configured orchestrator + <maintenance-owner>. Do NOT retry more than once — a failed recapture usually means credentials are wrong or PM has changed their login flow, not a transient network issue. Retry once after 60s, then escalate.

---

## After Successful Recapture

Resume the operation that triggered the session check:
- If triggered by a meld assignment: retry  or vendor assignment
- If triggered by morning scan: re-run 
- If triggered explicitly by the configured orchestrator: report success and stand by

---

## Chrome CDP Notes

The script uses Chrome DevTools Protocol on . Chrome must be launched with  for this to work. If Chrome is already running WITHOUT the debug port, the script will launch a second Chrome instance. This is expected behavior.

To avoid double-Chrome: ensure the agent's Chrome sessions are always started via  or set it as a default Chrome flag in Chrome's launch config.
