# KORMA-USA HubSpot provisioning

Creates the KORMA-USA HubSpot data model from the design doc "KORMA-USA HubSpot Design — CRM + Belt Rank Management".

| File | What it is |
|---|---|
| `definitions.mjs` | Single source of truth: 114 properties in 13 groups, 5 deal pipelines, draft rank ladders, legacy property list |
| `provision.mjs` | Creates what is missing in the portal. Dry run by default; additive only |
| `export.mjs` | Writes the review files below from `definitions.mjs` |
| `korma-hubspot-properties.csv` | Every property: object, group, internal name, label, field type, option values |
| `korma-hubspot-pipelines.csv` | Every pipeline stage with probability and outcome |
| `korma-hubspot-definitions.json` | The whole model as JSON |

## Run it (next session, logged in)

```bash
cd provisioning/korma
HS_TOKEN_KORMA=pat-... node provision.mjs                                    # dry run, prints the plan
HS_TOKEN_KORMA=pat-... node provision.mjs --apply --expect-portal <Hub ID>   # creates missing items
```

- **Token:** a KORMA-portal private app with `crm.schemas.contacts.write`, `crm.schemas.companies.write`, `crm.schemas.deals.write` (+ `.read`) and `crm.objects.deals.write`.
- **Safety:** `--apply` stops unless the token's Hub ID equals `--expect-portal`. It never deletes, archives, renames or retypes anything. Existing dropdowns only gain missing options. Type mismatches are reported as conflicts.
- **Not done here:** migrating values out of the legacy `changmookwan_*`, `wkmaf_*`, `whmaf_*` and `korma_date_of_birth` properties, or archiving them. That is a separate step after the website code is updated.

Edit `definitions.mjs`, run `node export.mjs`, and commit the regenerated CSV/JSON together.
