# zInspector connector (read-only)

A minimal, **read-only** client for the [zInspector](https://zinspector.com)
property-inspection API. It lets agents *read* inspection content — properties,
documents, **photos/media**, and inspection processes — the room-by-room detail
that AppFolio's inspection report doesn't carry. It cannot change anything in
zInspector: the client only issues HTTP `GET` and exposes no
create/update/delete methods.

> **Safety note.** Read-only by construction (no write code path), the key lives
> in gitignored `secrets.env`, and it can be revoked in zInspector anytime.
> Records include property/tenant detail and inspection media; treat output
> accordingly.

## Credentials

Set in `orgs/<org>/secrets.env` (preferred) or the process env:

| Variable                   | Meaning                                                      |
| -------------------------- | ----------------------------------------------------------- |
| `ZINSPECTOR_API_KEY`       | The **Encoded API key** (base64 of `KeyID:Secret`)          |
| `ZINSPECTOR_API_BASE_URL`  | Base URL — defaults to `https://portfolio.zinspector.com`   |

**Creating a working key** (zInspector → **Configuration → API Keys** →
`portfolio.zinspector.com/APIKey` → green **+**):

- **Linked User** must be an **Admin/Owner** — this is what grants the key data
  access. A key linked to an Editor gets `403 permission_denied` on everything.
- **At least one Whitelisted Domain or Source IP is required.** For this
  server-to-server connector, whitelist the **public IP of the machine that runs
  it**. If that IP changes (ISP), update the whitelist or the key will 403.
- Copy the **Encoded API key** into `ZINSPECTOR_API_KEY`.

## API shape

- **Auth:** header `x-api-key: <encoded key>` (never in the URL).
- **Call:** `GET {baseUrl}/api/{resource}/` — the **trailing slash is required**
  (a slashless path 301-redirects).
- **Reply:** `{ results: [ ...rows ], next: "<full URL>" | null, previous, count? }`
- **Paging:** two styles exist — cursor (`?cursor=` for `propertiesCursor`) and
  page (`?page=N` for `documents`/`media`) — but **both expose `next` as a full
  URL**, so the client just follows `next` until it's null (up to `--max-pages`,
  default 20).

### Read resources (examples)

| Resource            | Notes                                             |
| ------------------- | ------------------------------------------------- |
| `propertiesCursor`  | Properties (cursor-paginated).                    |
| `documents`         | Inspection documents/reports (page-paginated).    |
| `media`             | Inspection photos (page-paginated).               |
| `process`           | Inspection processes / tasks.                     |
| `contactsCursor`    | Contacts (cursor-paginated).                      |

## CLI usage

```bash
cortextos bus zinspector-get propertiesCursor
cortextos bus zinspector-get media --rows-only --max-rows 200
cortextos bus zinspector-get documents --query '{"property":123}'
```

Flags: `--org` (defaults to `CTX_ORG`), `--query <json>`, `--max-pages <n>`,
`--max-rows <n>`, `--rows-only`.
