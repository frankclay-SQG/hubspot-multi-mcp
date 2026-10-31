#!/usr/bin/env node
/**
 * Writes review files from definitions.mjs:
 *   korma-hubspot-properties.csv  every property (object, group, name, label, type, options)
 *   korma-hubspot-pipelines.csv   every deal pipeline stage with its probability
 *   korma-hubspot-definitions.json the full model, for scripts and the connector
 */
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { GROUPS, LADDERS, LEGACY, PIPELINES, PROPERTIES } from "./definitions.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const csv = (rows) => rows.map((r) => r.map((c) => `"${String(c ?? "").replace(/"/g, '""')}"`).join(",")).join("\r\n") + "\r\n";
const TYPE = { "string/text": "Single-line text", "string/phonenumber": "Phone number", "number/number": "Number", "date/date": "Date", "bool/booleancheckbox": "Single checkbox", "enumeration/select": "Dropdown", "enumeration/checkbox": "Multiple checkboxes" };
const OBJ = { contacts: "Contact", companies: "Company", deals: "Deal" };

const propRows = [["Object", "Group", "Internal name", "Label", "HubSpot field type", "type / fieldType", "Options (label = internal value)", "Description"]];
for (const [obj, props] of Object.entries(PROPERTIES)) {
  const glabel = Object.fromEntries(GROUPS[obj].map((g) => [g.name, g.label]));
  for (const p of props) {
    propRows.push([
      OBJ[obj],
      glabel[p.groupName],
      p.name,
      p.label,
      TYPE[`${p.type}/${p.fieldType}`],
      `${p.type}/${p.fieldType}`,
      p.type === "bool" ? "" : (p.options ?? []).map((o) => `${o.label} = ${o.value}`).join("; "),
      p.description,
    ]);
  }
}

const pipeRows = [["Pipeline", "Order", "Stage", "Probability", "Outcome"]];
for (const p of PIPELINES) {
  for (const s of p.stages) {
    const prob = Number(s.metadata.probability);
    pipeRows.push([p.label, s.displayOrder + 1, s.label, prob, prob === 1 ? "Closed won" : prob === 0 ? "Closed lost" : "Open"]);
  }
}

writeFileSync(join(here, "korma-hubspot-properties.csv"), "﻿" + csv(propRows));
writeFileSync(join(here, "korma-hubspot-pipelines.csv"), "﻿" + csv(pipeRows));
writeFileSync(join(here, "korma-hubspot-definitions.json"), JSON.stringify({ groups: GROUPS, properties: PROPERTIES, pipelines: PIPELINES, rankLadders: LADDERS, legacyProperties: LEGACY }, null, 2) + "\n");
console.log(`properties: ${propRows.length - 1} · pipeline stages: ${pipeRows.length - 1}`);
