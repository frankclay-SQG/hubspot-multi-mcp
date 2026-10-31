#!/usr/bin/env node
/**
 * Creates the KORMA-USA HubSpot data model (definitions.mjs) in a portal.
 *
 *   HS_TOKEN_KORMA=pat-... node provision.mjs                       # dry run: report only
 *   HS_TOKEN_KORMA=pat-... node provision.mjs --apply --expect-portal 12345678
 *
 * Safety:
 * - Dry run by default. --apply also requires --expect-portal, and the token's
 *   Hub ID must match it (stops a token for the wrong portal).
 * - Additive only: creates missing groups, properties and pipelines, and adds
 *   missing dropdown options to existing properties. It never deletes,
 *   archives, renames or changes the type of anything.
 * - Writes a JSON report next to this script.
 *
 * Token scopes needed: crm.schemas.contacts.write, crm.schemas.companies.write,
 * crm.schemas.deals.write (+ the matching .read), crm.objects.deals.write
 * (pipelines). Use a token for the KORMA portal only.
 */
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { GROUPS, PIPELINES, PROPERTIES } from "./definitions.mjs";

const BASE = "https://api.hubapi.com";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function client(token, fetchImpl = fetch) {
  return async function hs(method, path, body) {
    for (let attempt = 0; ; attempt++) {
      const res = await fetchImpl(`${BASE}${path}`, {
        method,
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      if ((res.status === 429 || res.status >= 500) && attempt < 4) {
        await sleep(Number(res.headers.get("retry-after")) * 1000 || 600 * 2 ** attempt);
        continue;
      }
      const text = await res.text();
      const json = text ? JSON.parse(text) : undefined;
      if (!res.ok) {
        const err = new Error(`${method} ${path} → HTTP ${res.status}: ${json?.message ?? text}`);
        err.status = res.status;
        throw err;
      }
      return json;
    }
  };
}

/**
 * Plans (and with apply=true, performs) every additive change. Returns a report.
 * @param {{ token?: string, apply?: boolean, expectPortal?: string, fetchImpl?: typeof fetch, log?: (...args: any[]) => void }} opts
 */
export async function provision({ token, apply = false, expectPortal, fetchImpl = fetch, log = console.log }) {
  if (!token) throw new Error("Set HS_TOKEN_KORMA to the KORMA portal's access token.");
  if (apply && !expectPortal) throw new Error("--apply needs --expect-portal <Hub ID> as a safety check.");
  const hs = client(token, fetchImpl);
  const report = { mode: apply ? "apply" : "dry-run", at: new Date().toISOString(), portal: null, actions: [], skipped: [], conflicts: [], errors: [] };
  const act = async (kind, label, fn) => {
    if (!apply) return report.actions.push({ kind, label, status: "planned" });
    try {
      await fn();
      report.actions.push({ kind, label, status: "done" });
    } catch (e) {
      report.errors.push({ kind, label, error: e.message });
    }
  };

  const acct = await hs("GET", "/account-info/v3/details");
  report.portal = { hubId: String(acct.portalId), accountType: acct.accountType };
  log(`Portal ${acct.portalId} (${acct.accountType ?? "unknown type"}) — ${report.mode}`);
  if (expectPortal && String(acct.portalId) !== String(expectPortal)) {
    throw new Error(`Token belongs to Hub ID ${acct.portalId}, not ${expectPortal}. Nothing was changed.`);
  }

  for (const objectType of Object.keys(PROPERTIES)) {
    const groups = (await hs("GET", `/crm/v3/properties/${objectType}/groups`)).results ?? [];
    const haveGroups = new Set(groups.map((g) => g.name));
    for (const g of GROUPS[objectType]) {
      if (haveGroups.has(g.name)) report.skipped.push({ kind: "group", label: `${objectType}.${g.name}` });
      else await act("create group", `${objectType}.${g.name}`, () => hs("POST", `/crm/v3/properties/${objectType}/groups`, g));
    }

    const props = (await hs("GET", `/crm/v3/properties/${objectType}`)).results ?? [];
    const byName = new Map(props.map((p) => [p.name, p]));
    for (const p of PROPERTIES[objectType]) {
      const label = `${objectType}.${p.name}`;
      const cur = byName.get(p.name);
      if (!cur) {
        await act("create property", label, () => hs("POST", `/crm/v3/properties/${objectType}`, p));
        continue;
      }
      if (cur.type !== p.type || cur.fieldType !== p.fieldType) {
        report.conflicts.push({ label, existing: `${cur.type}/${cur.fieldType}`, wanted: `${p.type}/${p.fieldType}`, note: "Left as is. Resolve by hand." });
        continue;
      }
      if (p.type === "enumeration" && !cur.hubspotDefined) {
        const have = new Set((cur.options ?? []).map((o) => o.value));
        const missing = (p.options ?? []).filter((o) => !have.has(o.value));
        if (missing.length) {
          const options = [...(cur.options ?? []), ...missing.map((o, i) => ({ ...o, displayOrder: (cur.options?.length ?? 0) + i }))];
          await act(`add ${missing.length} option(s)`, label, () => hs("PATCH", `/crm/v3/properties/${objectType}/${p.name}`, { options }));
          continue;
        }
      }
      report.skipped.push({ kind: "property", label });
    }
  }

  const pipes = (await hs("GET", "/crm/v3/pipelines/deals")).results ?? [];
  const haveLabels = new Set(pipes.map((p) => p.label));
  for (const p of PIPELINES) {
    if (haveLabels.has(p.label)) report.skipped.push({ kind: "pipeline", label: p.label });
    else await act("create pipeline", p.label, () => hs("POST", "/crm/v3/pipelines/deals", p));
  }

  const count = (s) => report.actions.filter((a) => a.status === s).length;
  log(`Planned: ${count("planned")} · done: ${count("done")} · already there: ${report.skipped.length} · conflicts: ${report.conflicts.length} · errors: ${report.errors.length}`);
  for (const c of report.conflicts) log(`  conflict ${c.label}: portal has ${c.existing}, design wants ${c.wanted}`);
  for (const e of report.errors) log(`  error ${e.label}: ${e.error}`);
  return report;
}

// ─── CLI ────────────────────────────────────────────────────────────────────
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const args = process.argv.slice(2);
  const flag = (n) => args.includes(n);
  const val = (n) => (args.includes(n) ? args[args.indexOf(n) + 1] : undefined);
  provision({ token: process.env.HS_TOKEN_KORMA, apply: flag("--apply"), expectPortal: val("--expect-portal") })
    .then((report) => {
      const file = join(dirname(fileURLToPath(import.meta.url)), `provision-report-${report.at.slice(0, 19).replace(/:/g, "")}.json`);
      writeFileSync(file, JSON.stringify(report, null, 2));
      console.log(`Report: ${file}`);
      process.exit(report.errors.length ? 1 : 0);
    })
    .catch((e) => {
      console.error(e.message);
      process.exit(1);
    });
}
