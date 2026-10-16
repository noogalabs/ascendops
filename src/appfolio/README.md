# AppFolio data connector (read-only)

Read-only access to AppFolio's **Reporting (Data) API v2**. Agents (and the CLI)
can pull report data out of AppFolio; this connector has **no write path** — the
Reporting API only ever returns data, so it cannot change anything in AppFolio.

## Configuration

Credentials live in `orgs/<org>/secrets.env` (gitignored — never committed):

```
APPFOLIO_CLIENT_ID=...          # Reports API Client ID  (Basic-auth username)
APPFOLIO_CLIENT_SECRET=...      # Reports API Client Secret (Basic-auth password)
APPFOLIO_API_BASE_URL=https://<your-db>.appfolio.com
```

Get the Client ID/Secret in AppFolio: account menu → General Settings →
Manage API Settings → **Reports API Credentials**.

## Usage

```
cortextos bus appfolio-report <report> [--filters '<json>'] [--max-pages N] [--max-rows N] [--rows-only]
```

Examples:

```
# First page of the rent roll
cortextos bus appfolio-report rent_roll --max-pages 1

# Active-property delinquencies, rows only
cortextos bus appfolio-report delinquency --rows-only

# Open work orders with a filter
cortextos bus appfolio-report work_order --filters '{"property_visibility":"active"}'
```

Output is JSON: `{ ok, report, rows[], pagesFetched, truncated, rowCount }`
(or just the `rows` array with `--rows-only`).

## Report names verified against a live AppFolio account (2026-06)

| Use case                      | Report name(s)                                   |
| ----------------------------- | ------------------------------------------------ |
| Rent roll / occupancy         | `rent_roll`, `unit_directory`, `tenant_directory`|
| Delinquency / collections     | `delinquency`, `aged_receivables_detail`         |
| Maintenance / work orders     | `work_order`                                     |
| Leasing & renewals            | `lease_expiration_detail`, `unit_vacancy`, `rental_applications` |

The report set differs per AppFolio account; a wrong name returns HTTP 400
(`"Id is not a valid report."`). Pass any valid report name — the connector is
generic, not limited to the list above. Note `rent_roll` already carries
`lease_to` / `lease_expires_month`, so lease expirations can also be derived
from it.

## Notes

- **Auth:** HTTP Basic (Client ID / Secret), sent as a header (never embedded in
  the URL, so secrets don't leak into logs).
- **Pagination:** automatic via `next_page_url`; capped at 20 pages by default
  (`--max-pages` / `--max-rows` to change). `truncated: true` means a cap, not
  AppFolio, stopped the walk.
- **Rate limit:** 7 requests / 15 s on base endpoints (429). The connector
  throttles between pages and retries once on 429 honoring `Retry-After`.

Code: `src/appfolio/api.ts` (client) · `src/bus/appfolio.ts` (creds + bus logic)
· command wired in `src/cli/bus.ts` · tests in `tests/unit/bus/appfolio.test.ts`.
