/**
 * Business logic behind the MCP tools. Every call names a portal; every
 * write passes the guardrails in guardrails.ts. Kept free of MCP types so it
 * can be unit-tested against a mocked fetch.
 */
import { audit } from "./audit";
import { assertConfirmed, assertNotBlocked, assertRecordId, assertWritable } from "./guardrails";
import { HubSpotClient, HubSpotError, type Fetch } from "./hubspot";
import { allPortals, getPortal, GuardrailError, portalTag, type ResolvedPortal } from "./portals";

export const READ_TYPES = ["contacts", "companies", "deals", "tickets", "tasks"] as const;
export const WRITE_TYPES = ["contacts", "companies", "deals", "tickets"] as const;
export const ASSOC_TYPES = ["contacts", "companies", "deals", "tickets"] as const;
export type ReadType = (typeof READ_TYPES)[number];
export type WriteType = (typeof WRITE_TYPES)[number];
export type AssocType = (typeof ASSOC_TYPES)[number];

const OBJECT_TYPE_IDS: Record<string, string> = {
  contacts: "0-1",
  companies: "0-2",
  deals: "0-3",
  tickets: "0-5",
};

const DEFAULT_PROPS: Record<ReadType, string[]> = {
  contacts: ["firstname", "lastname", "email", "phone", "company", "jobtitle", "lifecyclestage", "hs_lead_status", "createdate", "lastmodifieddate"],
  companies: ["name", "domain", "phone", "city", "state", "industry", "lifecyclestage", "createdate"],
  deals: ["dealname", "amount", "dealstage", "pipeline", "closedate", "hubspot_owner_id", "createdate"],
  tickets: ["subject", "content", "hs_pipeline", "hs_pipeline_stage", "hs_ticket_priority", "createdate"],
  tasks: ["hs_task_subject", "hs_task_body", "hs_task_status", "hs_task_priority", "hs_timestamp"],
};

/** Property used to find-or-create, and to read the domain-bearing value for the blocklist. */
const IDENTITY_PROP: Partial<Record<string, string>> = { contacts: "email", companies: "domain" };

const VERIFY_TTL_MS = 10 * 60 * 1000;

interface VerifyState {
  ok: boolean;
  checkedAt: number;
  tokenFingerprint: string;
  actualPortalId?: string;
  uiDomain?: string;
  accountType?: string;
  problem?: string;
}

export interface Ctx {
  user?: string;
}

export interface Filter {
  property: string;
  operator: string;
  value?: string;
  highValue?: string;
  values?: string[];
}

function fingerprint(token: string) {
  return `${token.length}:${token.slice(-6)}`;
}

export class Service {
  private verified = new Map<string, VerifyState>();

  constructor(
    private fetchImpl: Fetch = fetch,
    private now: () => number = Date.now,
  ) {}

  // ─── portal access ─────────────────────────────────────────────────────────

  /** Checks the token really belongs to the configured Hub ID (cached 10 min). */
  async verify(p: ResolvedPortal, force = false): Promise<VerifyState> {
    if (!p.token) {
      return { ok: false, checkedAt: this.now(), tokenFingerprint: "", problem: `No access token configured (${p.tokenEnv}).` };
    }
    const fp = fingerprint(p.token);
    const cached = this.verified.get(p.key);
    if (!force && cached && cached.tokenFingerprint === fp && this.now() - cached.checkedAt < VERIFY_TTL_MS) return cached;

    let state: VerifyState;
    try {
      const d = await new HubSpotClient(p.token, this.fetchImpl).accountDetails();
      const actual = String(d.portalId);
      const base = { checkedAt: this.now(), tokenFingerprint: fp, actualPortalId: actual, uiDomain: d.uiDomain, accountType: d.accountType };
      if (!p.expectedPortalId) {
        state = { ...base, ok: false, problem: `Expected Hub ID not set. This token belongs to Hub ID ${actual}; set ${p.portalIdEnv}=${actual} to enable this portal.` };
      } else if (actual !== p.expectedPortalId) {
        state = { ...base, ok: false, problem: `Token/portal MISMATCH: ${p.tokenEnv} belongs to Hub ID ${actual}, but "${p.key}" expects ${p.expectedPortalId}. Portal disabled until fixed.` };
      } else {
        state = { ...base, ok: true };
      }
    } catch (e) {
      const msg = e instanceof HubSpotError && e.status === 401 ? "Token rejected by HubSpot (expired or revoked)." : `Could not verify token: ${(e as Error).message}`;
      state = { ok: false, checkedAt: this.now(), tokenFingerprint: fp, problem: msg };
    }
    this.verified.set(p.key, state);
    return state;
  }

  private async open(key: string) {
    const p = getPortal(key);
    const v = await this.verify(p);
    if (!v.ok) throw new GuardrailError(`${portalTag(p)} unavailable: ${v.problem}`);
    return { p, v, hs: new HubSpotClient(p.token!, this.fetchImpl) };
  }

  private recordUrl(v: VerifyState, objectType: string, id: string) {
    const typeId = OBJECT_TYPE_IDS[objectType];
    if (!typeId || !v.actualPortalId) return undefined;
    return `https://${v.uiDomain || "app.hubspot.com"}/contacts/${v.actualPortalId}/record/${typeId}/${id}`;
  }

  private shape(v: VerifyState, objectType: string, r: any) {
    return { id: String(r.id), url: this.recordUrl(v, objectType, String(r.id)), properties: r.properties, ...(r.associations ? { associations: r.associations } : {}) };
  }

  /** Loads a record that must exist in THIS portal; refuses otherwise (cross-portal guard). */
  private async requireRecord(hs: HubSpotClient, p: ResolvedPortal, objectType: string, id: string, props: string[] = []) {
    assertRecordId(id);
    const r = await hs.get(objectType, id, props);
    if (!r) {
      throw new GuardrailError(
        `No ${objectType} record ${id} exists in ${portalTag(p)}. It may belong to a different portal; cross-portal writes are not allowed.`,
      );
    }
    return r;
  }

  /** Blocklist check for an existing contact/company (by its email/domain). */
  private async assertRecordNotBlocked(hs: HubSpotClient, p: ResolvedPortal, objectType: string, id: string) {
    const prop = IDENTITY_PROP[objectType];
    const r = await this.requireRecord(hs, p, objectType, id, prop ? [prop, "website"] : []);
    if (prop) assertNotBlocked(p, [r.properties?.[prop], r.properties?.website]);
    return r;
  }

  private async write<T>(key: string, confirm: string | undefined, tool: string, ctx: Ctx, fn: (o: { p: ResolvedPortal; v: VerifyState; hs: HubSpotClient }) => Promise<T & { recordId?: string; objectType?: string }>) {
    try {
      assertConfirmed(key, confirm);
      const o = await this.open(key);
      assertWritable(o.p);
      const out = await fn(o);
      audit({ portal: key, tool, objectType: out.objectType, recordId: out.recordId, outcome: "ok", user: ctx.user });
      return { tag: portalTag(o.p), ...out };
    } catch (e) {
      audit({ portal: key, tool, outcome: e instanceof GuardrailError ? "refused" : "error", detail: (e as Error).message.slice(0, 200), user: ctx.user });
      throw e;
    }
  }

  // ─── reads ─────────────────────────────────────────────────────────────────

  async listPortals() {
    const out = [];
    for (const p of allPortals()) {
      const v = await this.verify(p, true);
      out.push({
        portal: p.key,
        label: p.label,
        hubId: v.actualPortalId ?? p.expectedPortalId ?? null,
        status: v.ok ? "ok" : "unavailable",
        problem: v.problem,
        accountType: v.accountType,
        writesAllowed: p.writesAllowed,
        blockedDomains: p.blockedDomains,
      });
    }
    return out;
  }

  async search(key: string, objectType: ReadType, opts: { query?: string; filters?: Filter[]; properties?: string[]; limit?: number; after?: string; sortBy?: string; sortDirection?: "ASCENDING" | "DESCENDING" }) {
    const { p, v, hs } = await this.open(key);
    const body: any = {
      limit: Math.min(Math.max(opts.limit ?? 20, 1), 100),
      properties: opts.properties?.length ? opts.properties : DEFAULT_PROPS[objectType],
    };
    if (opts.query) body.query = opts.query;
    if (opts.filters?.length) body.filterGroups = [{ filters: opts.filters.map((f) => ({ propertyName: f.property, operator: f.operator, value: f.value, highValue: f.highValue, values: f.values })) }];
    if (opts.after) body.after = opts.after;
    if (opts.sortBy) body.sorts = [{ propertyName: opts.sortBy, direction: opts.sortDirection ?? "DESCENDING" }];
    const r = await hs.search(objectType, body);
    return { tag: portalTag(p), total: r.total, results: r.results.map((x) => this.shape(v, objectType, x)), nextAfter: r.paging?.next?.after };
  }

  async getRecord(key: string, objectType: ReadType, id: string, properties?: string[], associations?: string[]) {
    assertRecordId(id);
    const { p, v, hs } = await this.open(key);
    const r = await hs.get(objectType, id, properties?.length ? properties : DEFAULT_PROPS[objectType], associations ?? []);
    if (!r) return { tag: portalTag(p), found: false, message: `No ${objectType} record ${id} in this portal.` };
    return { tag: portalTag(p), found: true, record: this.shape(v, objectType, r) };
  }

  async listProperties(key: string, objectType: ReadType, nameContains?: string) {
    const { p, hs } = await this.open(key);
    const r = await hs.properties(objectType);
    const needle = nameContains?.toLowerCase();
    const props = r.results
      .filter((x) => !needle || x.name.toLowerCase().includes(needle) || String(x.label).toLowerCase().includes(needle))
      .map((x) => ({ name: x.name, label: x.label, type: x.type, fieldType: x.fieldType, options: x.options?.length ? x.options.map((o: any) => o.value) : undefined }));
    return { tag: portalTag(p), count: props.length, properties: props };
  }

  async listPipelines(key: string, objectType: "deals" | "tickets") {
    const { p, hs } = await this.open(key);
    const r = await hs.pipelines(objectType);
    return {
      tag: portalTag(p),
      pipelines: r.results.map((pl) => ({ id: pl.id, label: pl.label, stages: pl.stages?.map((s: any) => ({ id: s.id, label: s.label })) })),
    };
  }

  async getNotes(key: string, objectType: AssocType, id: string, limit = 20) {
    assertRecordId(id);
    const { p, hs } = await this.open(key);
    const assoc = await hs.listAssociations(objectType, id, "notes");
    const ids = assoc.results.map((a) => String(a.toObjectId)).slice(0, Math.min(limit, 100));
    if (!ids.length) return { tag: portalTag(p), notes: [] };
    const r = await hs.batchRead("notes", ids, ["hs_note_body", "hs_timestamp"]);
    const notes = r.results
      .map((n) => ({ id: String(n.id), timestamp: n.properties?.hs_timestamp, body: n.properties?.hs_note_body }))
      .sort((a, b) => String(b.timestamp).localeCompare(String(a.timestamp)));
    return { tag: portalTag(p), notes };
  }

  /** Read-only lookup of one email or company domain/name across every available portal. */
  async findAcrossPortals(opts: { email?: string; domain?: string; companyName?: string }) {
    if (!opts.email && !opts.domain && !opts.companyName) throw new GuardrailError("Give an email, domain or companyName.");
    const out = [];
    for (const p of allPortals()) {
      const v = await this.verify(p);
      if (!v.ok) {
        out.push({ portal: p.key, label: p.label, status: "unavailable", problem: v.problem });
        continue;
      }
      const hs = new HubSpotClient(p.token!, this.fetchImpl);
      const matches: any[] = [];
      if (opts.email) {
        const r = await hs.search("contacts", { filterGroups: [{ filters: [{ propertyName: "email", operator: "EQ", value: opts.email }] }], properties: ["firstname", "lastname", "email", "company"], limit: 5 });
        matches.push(...r.results.map((x) => ({ type: "contacts", ...this.shape(v, "contacts", x) })));
      }
      if (opts.domain) {
        const r = await hs.search("companies", { filterGroups: [{ filters: [{ propertyName: "domain", operator: "EQ", value: opts.domain }] }], properties: ["name", "domain"], limit: 5 });
        matches.push(...r.results.map((x) => ({ type: "companies", ...this.shape(v, "companies", x) })));
      }
      if (opts.companyName) {
        const r = await hs.search("companies", { query: opts.companyName, properties: ["name", "domain"], limit: 5 });
        matches.push(...r.results.map((x) => ({ type: "companies", ...this.shape(v, "companies", x) })));
      }
      out.push({ portal: p.key, label: p.label, status: "ok", matches });
    }
    return { results: out };
  }

  // ─── writes ────────────────────────────────────────────────────────────────

  /** Find-or-create. Existing contacts/companies are returned untouched — never overwritten. */
  createRecord(key: string, confirm: string | undefined, objectType: WriteType, properties: Record<string, string>, ctx: Ctx = {}) {
    return this.write(key, confirm, "create_record", ctx, async ({ p, v, hs }) => {
      assertNotBlocked(p, [properties.email, properties.domain, properties.website]);
      const idProp = IDENTITY_PROP[objectType];
      if (idProp) {
        const value = properties[idProp];
        if (!value) throw new GuardrailError(`Creating ${objectType} requires the "${idProp}" property (used to avoid duplicates).`);
        const existing = await hs.search(objectType, { filterGroups: [{ filters: [{ propertyName: idProp, operator: "EQ", value }] }], properties: DEFAULT_PROPS[objectType], limit: 1 });
        if (existing.results.length) {
          const r = existing.results[0];
          return { created: false, message: `A ${objectType} record with ${idProp}=${value} already exists; left unchanged.`, record: this.shape(v, objectType, r), objectType, recordId: String(r.id) };
        }
      }
      if (objectType === "deals" && !properties.dealname) throw new GuardrailError('Creating a deal requires "dealname".');
      if (objectType === "tickets" && !properties.subject) throw new GuardrailError('Creating a ticket requires "subject".');
      const r = await hs.create(objectType, properties);
      return { created: true, record: this.shape(v, objectType, r), objectType, recordId: String(r.id) };
    });
  }

  /** Changes only the named properties; returns before/after values. */
  updateRecord(key: string, confirm: string | undefined, objectType: WriteType, id: string, properties: Record<string, string>, ctx: Ctx = {}) {
    return this.write(key, confirm, "update_record", ctx, async ({ p, v, hs }) => {
      if (!Object.keys(properties).length) throw new GuardrailError("No properties given to update.");
      const idProp = IDENTITY_PROP[objectType];
      const before = await this.requireRecord(hs, p, objectType, id, [...new Set([...Object.keys(properties), ...(idProp ? [idProp, "website"] : [])])]);
      if (idProp) assertNotBlocked(p, [before.properties?.[idProp], before.properties?.website]);
      assertNotBlocked(p, [properties.email, properties.domain, properties.website]);
      const after = await hs.update(objectType, id, properties);
      const changes = Object.keys(properties).map((k) => ({ property: k, before: before.properties?.[k] ?? null, after: after.properties?.[k] ?? properties[k] }));
      return { updated: true, url: this.recordUrl(v, objectType, id), changes, objectType, recordId: id };
    });
  }

  createNote(key: string, confirm: string | undefined, objectType: AssocType, id: string, body: string, ctx: Ctx = {}) {
    return this.write(key, confirm, "create_note", ctx, async ({ p, v, hs }) => {
      await this.assertRecordNotBlocked(hs, p, objectType, id);
      const note = await hs.create("notes", { hs_note_body: body, hs_timestamp: new Date(this.now()).toISOString() });
      await hs.associateDefault("notes", String(note.id), objectType, id);
      return { noteId: String(note.id), attachedTo: { objectType, id, url: this.recordUrl(v, objectType, id) }, objectType: "notes", recordId: String(note.id) };
    });
  }

  createTask(
    key: string,
    confirm: string | undefined,
    t: { subject: string; body?: string; dueDate: string; priority?: "LOW" | "MEDIUM" | "HIGH"; relatedType?: AssocType; relatedId?: string },
    ctx: Ctx = {},
  ) {
    return this.write(key, confirm, "create_task", ctx, async ({ p, v, hs }) => {
      const due = new Date(t.dueDate);
      if (Number.isNaN(due.getTime())) throw new GuardrailError(`"${t.dueDate}" is not a valid date. Use YYYY-MM-DD or an ISO timestamp.`);
      if ((t.relatedType && !t.relatedId) || (!t.relatedType && t.relatedId)) throw new GuardrailError("Give both relatedType and relatedId, or neither.");
      if (t.relatedType && t.relatedId) await this.assertRecordNotBlocked(hs, p, t.relatedType, t.relatedId);
      const task = await hs.create("tasks", {
        hs_task_subject: t.subject,
        ...(t.body ? { hs_task_body: t.body } : {}),
        hs_timestamp: due.toISOString(),
        hs_task_status: "NOT_STARTED",
        hs_task_priority: t.priority ?? "MEDIUM",
        hs_task_type: "TODO",
      });
      if (t.relatedType && t.relatedId) await hs.associateDefault("tasks", String(task.id), t.relatedType, t.relatedId);
      return {
        taskId: String(task.id),
        due: due.toISOString(),
        relatedTo: t.relatedType ? { objectType: t.relatedType, id: t.relatedId, url: this.recordUrl(v, t.relatedType, t.relatedId!) } : null,
        objectType: "tasks",
        recordId: String(task.id),
      };
    });
  }

  /** Links two records in the SAME portal. */
  associate(key: string, confirm: string | undefined, fromType: AssocType, fromId: string, toType: AssocType, toId: string, ctx: Ctx = {}) {
    return this.write(key, confirm, "associate", ctx, async ({ p, hs }) => {
      await this.assertRecordNotBlocked(hs, p, fromType, fromId);
      await this.assertRecordNotBlocked(hs, p, toType, toId);
      await hs.associateDefault(fromType, fromId, toType, toId);
      return { associated: true, from: { objectType: fromType, id: fromId }, to: { objectType: toType, id: toId }, objectType: fromType, recordId: fromId };
    });
  }
}
