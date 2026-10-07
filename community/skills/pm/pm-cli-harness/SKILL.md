---
name: pm-cli-harness
description: "CLI for Property Meld work order management. snapcli (pm) is the primary tool for all PM operations — use it first. Nexus API is secondary (reads + maintenance_notes). Manual UI is last resort only if snapcli itself is broken."
effort: low
triggers: ["pm work-orders", "pm assign-tech", "meld triage"]
---
## Member Role Bindings

Before applying this skill, read the member organization configuration and bind
`<maintenance-owner>` to its escalation/approval owner and approved contact route,
`<maintenance-agent>` to its maintenance agent, and `<orchestrator-agent>` to its
coordinator. Use `CTX_ORCHESTRATOR_AGENT` for executable bus examples and
`CTX_AGENT_NAME` for the running agent's paths. Resolve vendor and in-house
technician placeholders from the same member configuration; bind `PM_IN_HOUSE_TECH`
to the selected member technician for executable assignment examples. If a required role
is missing or ambiguous, ask the configured coordinator before dispatch; never
substitute a person, agent or chat ID from an example. Existing emergency and
approval rules still govern actions.


# Property Meld CLI

## Tool Hierarchy — Follow This Order

1. **snapcli (`pm`)** — primary tool for ALL PM operations. Plain HTTP with captured session cookies. No Playwright, no browser. Use this first.
2. **Nexus API** (`pm-read-melds.py`, OAuth2 client credentials) — secondary. Good for bulk meld reads and `maintenance_notes` writes. Blocked on assignment/merge/chat write operations.
3. **Manual PM UI** — last resort only if snapcli is broken (expired cookies, site layout change). Do NOT fall back here just because Nexus API returns 404.

## Setup

```bash
pip install -e ~/projects/cli-anything-propertymeld/
# Required env vars (from agent .env):
#   PM_CREDS_PATH (default: ~/.claude/credentials/property-meld.json)
#   PM_CLIENT_ID, PM_CLIENT_SECRET  (Nexus API fallback only)
```

## Session Capture — When Cookies Expire

Property Meld uses Google Sign-In via Safari. When `pm` returns 401/403 or the session is otherwise stale, recapture from Safari's binary cookie store. **Do NOT use SafariDriver/Selenium/Playwright login automation** — Google's sign-in flow breaks under automation.

**Method:** `snapcli.capture.safari` parses Safari's binary cookie file directly (no automation, no login flow).

```python
import os
import sys
sys.path.insert(0, os.environ.get('SNAPCLI_PATH', ''))  # set SNAPCLI_PATH to your cli-anything-snapcli checkout
from snapcli.capture.safari import capture
from pathlib import Path

capture(
    "propertymeld.com",
    str(Path.home() / ".claude/credentials/property-meld.json"),
    cookie_file=str(Path.home() / "Library/Containers/com.apple.Safari/Data/Library/Cookies/Cookies.binarycookies"),
)
```

**Prerequisites:**
- <maintenance-owner> must already be logged into propertymeld.com in Safari (the parser only reads, it does not log in)
- Safari cookie store path: `~/Library/Containers/com.apple.Safari/Data/Library/Cookies/Cookies.binarycookies`
- Output: ~14 cookies including the `sessionid` cookie

**Verify after capture:**
```bash
pm work-orders list --status open --limit 1 --json   # Should return real data, not 401
```

If the parser returns "0 cookies for propertymeld.com", <maintenance-owner> needs to log in to PM in Safari first, then re-run the capture.

## Commands

### Work Orders
```bash
pm work-orders list --status open --json          # List open work orders
pm work-orders list --status pending --json       # Pending completion
pm work-orders list --limit 50 --json             # More results
pm work-orders get <meld_id> --json               # Single work order detail
pm work-orders comments <meld_id> --json          # Get comments/notes
pm work-orders send-message <meld_id> "<text>" --json  # Post message/comment
pm work-orders clone --meld-id <meld_id> --json   # Clone a meld
pm work-orders merge --meld-id <src> --into <dst> --json  # Merge src into dst (same unit required)
pm work-orders complete --meld-id <id> --json     # Mark complete (meld must be PENDING_COMPLETION)
pm work-orders complete --meld-id <id> --notes "text" --json  # Complete with notes
pm work-orders cancel --meld-id <id> --json       # Cancel meld
pm work-orders cancel --meld-id <id> --reason "text" --json   # Cancel with reason
pm work-orders schedule --meld-id <id> --dtstart 2026-04-27T14:00:00-04:00 --hours 2 --json  # Schedule in-house tech (must include timezone)
pm work-orders schedule-vendor --meld-id <id> --vendor-id <vid> --dtstart 2026-04-27T14:00:00-04:00 --hours 2 --json  # Schedule vendor
pm work-orders assign-vendor --meld-id <id> --vendor-id <id> --json  # Assign vendor
```

### Tenants
```bash
pm tenants list --json                            # All tenants (up to 100)
pm tenants list --search "Christy" --json         # Filter by name, email, or phone
pm tenants list --search "(423) 400" --json       # Search by phone substring
pm tenants get <tenant_id> --json                 # Single tenant detail
```

### Properties & Vendors
```bash
pm properties list --json                         # All properties
pm vendors list --json                            # All vendors
```

### Tech Assignment (in-house)
```bash
pm assign-tech --work-order-id <id> --tech "${PM_IN_HOUSE_TECH:?Bind a member-configured technician}" --json
```

### Vendor Assignment
```bash
# Top-level (preferred — mirrors assign-tech UX):
pm assign-vendor --work-order-id 12345 --vendor Rogers --json
pm assign-vendor --work-order-id 12345 --vendor "Example Electric" --json

# Nested form (still works, takes numeric vendor-id):
pm work-orders assign-vendor --meld-id 12345 --vendor-id 92504 --json
```
Result: status changes to PENDING_VENDOR. Vendor name uses partial match against `pm vendors list`.

### External Vendor Assignment
```bash
pm work-orders assign-vendor --meld-id <id> --vendor-id <id> --json
pm work-orders assign-vendor --meld-id 12345 --vendor-id 67890 --json
# Optional account prefix (default "1"):
pm work-orders assign-vendor --meld-id 12345 --vendor-id 67890 --account 2 --json
```
Result: status changes to PENDING_VENDOR with vendor_assignment_request

### Projects
```bash
pm projects list --json                           # List all projects
pm projects list --meld-id 12345 --json           # List projects for a meld
pm projects get <project_id> --json               # Get project details
pm projects create --name "Electrical Rewire" --description "Kitchen and bathrooms" --json
pm projects update <project_id> --name "..." --status active|archived --json
pm projects delete <project_id> --json            # Archive a project
```

### Invoices
```bash
pm invoices list --json                           # List all invoices
pm invoices list --meld-id 12345 --json           # List invoices for a meld
pm invoices list --status issued --json           # Filter by status
pm invoices get <invoice_id> --json               # Get invoice details
pm invoices create --meld-id 12345 --invoice-number "INV-001" --amount 1500.00 --description "Labor and materials" --json
pm invoices create --meld-id 12345 --invoice-number "INV-001" --amount 1500.00 --due-date 2026-05-15 --json
pm invoices update <invoice_id> --status issued --json  # Mark as issued
pm invoices link <invoice_id> --meld-id 12345 --json    # Link invoice to a meld
```

### Receipts
```bash
pm receipts list --json                           # List all receipts
pm receipts list --meld-id 12345 --json           # List receipts for a meld
pm receipts get <receipt_id> --json               # Get receipt details
pm receipts upload --meld-id 12345 --file /path/to/receipt.pdf --json
pm receipts upload --meld-id 12345 --file receipt.jpg --description "Material invoice" --json
pm receipts upload --meld-id 12345 --file receipt.pdf --invoice-id 678 --json  # Link to invoice
pm receipts link <receipt_id> --invoice-id 678 --json  # Link existing receipt to invoice
```

### Vendor Invitations
```bash
pm vendor-invites send --meld-id 12345 --vendor-id 999 --json
pm vendor-invites send --meld-id 12345 --vendor-id 999 --message "Please quote for full bathroom remodel" --json
pm vendor-invites list --json                      # List all invitations
pm vendor-invites list --meld-id 12345 --json     # List invitations for a meld
pm vendor-invites list --status pending --json    # Filter by status
pm vendor-invites get <invitation_id> --json      # Get invitation details
pm vendor-invites resend <invitation_id> --json   # Resend an invitation
pm vendor-invites cancel <invitation_id> --json   # Cancel an invitation
```

### Health Check
```bash
pm probe --json                                   # Verify credentials
```

## Backend Notes

| Command | Backend | Auth |
|---------|---------|------|
| work-orders list/get/comments/send-message | snapcli (plain HTTP) | PM_CREDS_PATH cookies |
| work-orders clone/merge/complete/cancel | snapcli (plain HTTP) | PM_CREDS_PATH cookies |
| work-orders schedule/assign-vendor | snapcli (plain HTTP) | PM_CREDS_PATH cookies |
| assign-tech (in-house) | snapcli (plain HTTP) | PM_CREDS_PATH cookies |
| tenants list/get | snapcli (plain HTTP) | PM_CREDS_PATH cookies |
| projects list/get/create/update/delete | snapcli (plain HTTP) | PM_CREDS_PATH cookies |
| invoices list/get/create/update/link | snapcli (plain HTTP) | PM_CREDS_PATH cookies |
| receipts list/get/upload/link | snapcli (plain HTTP) | PM_CREDS_PATH cookies |
| vendor-invites send/list/get/resend/cancel | snapcli (plain HTTP) | PM_CREDS_PATH cookies |
| properties/vendors list | Nexus API | PM_CLIENT_ID/SECRET |
| maintenance_notes PATCH | Nexus API | PM_CLIENT_ID/SECRET |

## Notes
- `complete` requires meld to be in PENDING_COMPLETION status. Applies to work by any in-house tech (the member-configured technicians or any future in-house assignment).
- `merge` requires both melds to be at the same unit. Source meld gets MANAGER_CANCELED with "(Merged)" prefix.
- `tenants list --search` does client-side filtering (server does not support name/email query params).

## Known Gaps (no API or snapcli path)
- Chat message deletion/editing — browser UI only
- Tenant create/update — tenants/{id} PUT is supported by server but not yet wired as a CLI command
