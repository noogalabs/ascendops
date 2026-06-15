---
name: pm
description: "CLI for Property Meld work order management. Read work orders, properties, and vendors via the Nexus API; assign techs via browser automation. Use when working with Property Meld melds, work orders, or tech assignment."
triggers: ["property meld", "work order", "meld", "pm work-orders", "pm assign-tech", "meld triage"]
---

# Property Meld CLI (pm)

Connect your agent to Property Meld: read work orders, properties, and vendors, and assign techs — from the command line instead of clicking through the web UI.

## Install

```bash
pipx install --include-deps git+https://github.com/noogalabs/cli-anything-pm.git
```

This installs the `pm` command globally. Verify it landed:

```bash
pm --help
```

> **No PyPI package** — install from the git URL above, not `pipx install cli-anything-pm`.
>
> **Use `--include-deps`.** Without it, pipx exposes only `pm`, not the `playwright`
> command that the browser-backed commands (`assign-tech`, `comments`) need below —
> you'd hit `playwright: command not found`. `--include-deps` puts `playwright` on
> your PATH too.

## Before it works — your own credentials (required)

Installing the `pm` command is not enough on its own. `pm` talks to **your** Property Meld account, so you must provide your own credentials. Nothing here is shared or pre-filled.

1. **Nexus API (read commands)** — set these environment variables to your Property Meld Nexus API client credentials, plus your own tenant id:
   ```bash
   export PM_CLIENT_ID=your_client_id
   export PM_CLIENT_SECRET=your_client_secret
   export PM_MULTITENANT_ID=your_tenant_id    # REQUIRED — your Property Meld tenant id
   ```
   > **Set `PM_MULTITENANT_ID` to your own tenant id.** It identifies *which* Property
   > Meld account the CLI talks to. If you leave it unset, the CLI falls back to a
   > built-in default that is **not yours**, and every command would silently run
   > against the wrong account. Your tenant id is the number in your Property Meld URL
   > (`app.propertymeld.com/<tenant-id>/...`).
2. **Browser backend (assign-tech, comments) — only if you use those commands.** The
   Nexus read commands above need no browser. For the browser-backed commands, install
   a browser and point at your login session (the `playwright` command is available
   because you installed with `--include-deps`):
   ```bash
   playwright install chromium
   # Point PM_CREDS_PATH at your Property Meld login JSON
   # (default: ~/.claude/credentials/property-meld.json)
   ```

Confirm credentials are working:

```bash
pm probe --json
```

## Commands

### Work Orders
```bash
pm work-orders list --status open --json          # Open (pending assignment, vendor, or mgmt availability)
pm work-orders list --status pending --json       # Awaiting vendor (PENDING_VENDOR)
pm work-orders list --limit 50 --json             # More results
# Status slugs: open | pending | completed | canceled. Any other value is passed
# through as a raw PM status (e.g. --status PENDING_COMPLETION).
pm work-orders get <meld_id> --json               # Single work order detail
pm work-orders comments <meld_id> --json          # Get comments/notes (browser)
```

### Properties & Vendors
```bash
pm properties list --json                          # All properties
pm vendors list --json                             # All vendors
```

### Tech Assignment (browser backend)
```bash
pm assign-tech --work-order-id <id> --tech Carlos --json
```

### Health Check
```bash
pm probe --json                                    # Verify API credentials
```

## Backend Notes

| Command | Backend | Requires |
|---------|---------|---------|
| work-orders list | Nexus API | PM_CLIENT_ID, PM_CLIENT_SECRET |
| work-orders get | Nexus API | PM_CLIENT_ID, PM_CLIENT_SECRET |
| work-orders comments | Browser (Playwright) | PM_CREDS_PATH + cookies |
| properties list | Nexus API | PM_CLIENT_ID, PM_CLIENT_SECRET |
| vendors list | Nexus API | PM_CLIENT_ID, PM_CLIENT_SECRET |
| assign-tech | Browser (Playwright) | PM_CREDS_PATH + cookies |

## Source

Tool repo: https://github.com/noogalabs/cli-anything-pm
