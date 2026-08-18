# Tenant Turner connector (read-only)

A minimal, **read-only** client for the [Tenant Turner](https://tenantturner.com)
API v1 — the leasing / showing-scheduling platform. It lets agents *read* the
leasing pipeline (leads, their scheduled showings, and pre-screening answers).
It cannot change anything in Tenant Turner: the client only issues HTTP `GET`
and exposes no create/update/delete methods.

> **Safety note.** Tenant Turner's private API key is account-level and *can*
> write (`POST /v1/showings` books a showing). The guarantee here is
> *read-only by construction* — there is simply no write code path — plus the
> key living in gitignored `secrets.env` and being revocable/refreshable in the
> Tenant Turner dashboard. Records include applicant PII (income, eviction /
> bankruptcy history); treat output accordingly.

## Credentials

Set in `orgs/<org>/secrets.env` (preferred) or the process env:

| Variable                | Meaning                                                    |
| ----------------------- | ---------------------------------------------------------- |
| `TENANTTURNER_API_KEY`  | Account private API key — Settings → Tenant Turner API     |

The connector reads `process.env` first (agent PTY context), then falls back to
`orgs/<org>/secrets.env` so the same command works from a plain CLI.

## API shape

- **Auth:** HTTP Basic where the value is `base64(apiKey)` (the bare key, no
  `username:password`). Sent as an `Authorization` header, never in the URL.
- **Base URL:** `https://api.tenantturner.com`
- **Call:** `GET /v1/{resource}?SinceDateUpdated=YYYY-MM-DD`
  - `SinceDateUpdated` is **required** by `applications` (and must be within the
    last 2 years); `properties` needs no params.
- **Reply:** `{ TotalCount, NextPage: "<base64 cursor>" | null, Data: [ ...rows ] }`
- **Paging:** follow the opaque `NextPage` cursor by passing it back as
  `?NextPage=<cursor>` (it already encodes the page size + `SinceDateUpdated`).
  ~10 rows/page. The client walks pages up to `--max-pages` (default 20).

### Read resources

| Resource       | Notes                                                                             |
| -------------- | --------------------------------------------------------------------------------- |
| `applications` | The unified lead record: contact, income, acquisition source, pre-screening answers, and a nested `Showings[]` array (times + status). Needs `--since`. |
| `properties`   | Listings pushed to Tenant Turner. No `--since` required.                          |

`GET /v1/showings` is **write-only** (POST books a showing) and is never used.

## CLI usage

```bash
# New / updated leads (with their showings) since a date
cortextos bus tenantturner-get applications --since 2026-06-25

# Just the row objects (for scripts), capped
cortextos bus tenantturner-get applications --since 2026-06-25 --rows-only --max-rows 200

# Listings
cortextos bus tenantturner-get properties
```

Flags: `--org` (defaults to `CTX_ORG`), `--since <YYYY-MM-DD>`, `--query <json>`,
`--max-pages <n>`, `--max-rows <n>`, `--rows-only`.
