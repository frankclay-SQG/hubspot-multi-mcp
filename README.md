# HubSpot Multi-Portal MCP

A private MCP server that gives Claude access to several HubSpot portals through **one** custom connector. Every tool call names its portal, and guardrails keep data from crossing between portals.

| Portal key | Portal |
|---|---|
| `newdawn` | New Dawn Insurance Agency (Hub ID 246454273) |
| `clay` | Clay Agency |
| `sqg` | Software Quality Guru |

Add or change portals in `lib/portals.ts`.

## Tools

**Read (no confirmation):** `list_portals`, `search_records`, `get_record`, `list_properties`, `list_pipelines`, `get_notes`, `find_across_portals`.

**Write (Claude asks first):** `create_record` (find-or-create; never overwrites), `update_record` (returns before/after), `create_note`, `create_task`, `associate`.

**Not included:** delete, merge, bulk import, and cross-portal copy. Do those in HubSpot itself.

## Guardrails

1. `portal` is required on every tool, with no default. Every response starts with `[portal: key — Name]`.
2. Each token is checked against HubSpot (`/account-info/v3/details`) every 10 minutes. A token that belongs to the wrong Hub ID disables that portal.
3. Writes need `confirm_portal` equal to `portal`.
4. Per-portal blocked domains: `hologic.com` is blocked in `newdawn` and `clay`. This covers new records, emails changed to a blocked domain, and notes, tasks or associations on existing blocked records.
5. Record IDs are checked in the target portal before any write. An ID from another portal is refused.
6. HTTP 429 and 5xx responses are retried with backoff.
7. Every write emits a JSON `audit` line to the Vercel logs, with IDs only and no personal data.

## Setup

1. **HubSpot:** in each portal go to Settings → Integrations → Private Apps (or Legacy Apps / Development → Apps) and create `Claude Multi-Portal Connector` with these scopes:
   - `crm.objects.contacts.read/write`
   - `crm.objects.companies.read/write`
   - `crm.objects.deals.read/write`
   - `tickets` (optional)
   - `crm.schemas.contacts.read`, `crm.schemas.companies.read`, `crm.schemas.deals.read`
   - `crm.objects.owners.read`
2. **Vercel env vars:** see `.env.example`.
3. **OAuth provider** (WorkOS AuthKit or Clerk):
   - Enable dynamic client registration / MCP support.
   - Turn on Google sign-in and disable public sign-ups.
   - Set `AUTH_ISSUER`.
4. **First connect:** add `https://<deployment>/mcp` in claude.ai → Settings → Connectors → Add custom connector, then sign in. The first attempt is denied and logs your `sub`. Put it in `ALLOWED_SUBJECTS` and redeploy.
5. **Turn off** the built-in HubSpot connector in Claude so it doesn't get picked by mistake.

## Development

```bash
npm install
npm test          # guardrail + auth tests against a fake HubSpot
npm run typecheck
MCP_DEV_NO_AUTH=1 HS_TOKEN_SQG=... HS_PORTAL_ID_SQG=... npm run dev
npx @modelcontextprotocol/inspector   # point at http://localhost:3000/mcp
```
