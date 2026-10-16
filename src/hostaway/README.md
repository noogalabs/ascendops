# Hostaway data connector (read-only)

Read-only access to the **Hostaway Public API v1** (vacation/short-term rentals).
Agents (and the CLI) can pull data out of Hostaway; this connector is read-only
**by construction** — it only ever issues HTTP GET and exposes no
create/update/delete methods. Hostaway's API key is account-level and *could*
write, so the safety guarantee is that the agents' tool has no write code path.

## Configuration

Credentials live in `orgs/<org>/secrets.env` (gitignored — never committed):

```
HOSTAWAY_ACCOUNT_ID=...   # OAuth client_id
HOSTAWAY_API_KEY=...       # OAuth client_secret (shown only once in Hostaway)
```

Get them in Hostaway: **Settings → Hostaway API → Create** → name it → save the
**Account ID** and **API Key** (the key is shown only once). Revoke anytime from
the same screen.

The connector trades these for a Bearer access token automatically
(client-credentials grant at `/v1/accessTokens`); you don't manage the token.

## Usage

```
cortextos bus hostaway-get <resource> [--query '<json>'] [--max-pages N] [--max-rows N] [--rows-only]
```

Examples:

```
# Your listings
cortextos bus hostaway-get listings --rows-only

# Reservations (first page)
cortextos bus hostaway-get reservations --max-pages 1

# Calendar for one listing
cortextos bus hostaway-get calendar --query '{"listingId":151111}'
```

Output is JSON: `{ ok, resource, rows[], pagesFetched, truncated, rowCount }`
(or just the `rows` array with `--rows-only`).

Common read-only resources: `listings`, `reservations`, `calendar`,
`conversations`, `guests`, `reviews`. The exact set depends on your Hostaway
plan; a wrong name returns an error.

## Notes

- **Auth:** OAuth2 client-credentials. Account ID + API Key → Bearer token
  (minted per process, reused across that run's requests). Sent as a header.
- **Pagination:** automatic via `limit`/`offset`, capped at 20 pages by default
  (`--max-pages` / `--max-rows`). `truncated: true` means a cap stopped the walk.
- **Read-only:** there is no write method anywhere in this client.

Code: `src/hostaway/api.ts` (client) · `src/bus/hostaway.ts` (creds + bus logic)
· command wired in `src/cli/bus.ts` · tests in `tests/unit/bus/hostaway.test.ts`.
