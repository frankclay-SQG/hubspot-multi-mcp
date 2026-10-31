import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { domainOf, isBlockedDomain } from "@/lib/guardrails";
import { GuardrailError } from "@/lib/portals";
import { Service } from "@/lib/service";

/**
 * Minimal fake HubSpot: one in-memory store per token, keyed by Hub ID.
 * Covers only the endpoints the service uses.
 */
type Rec = { id: string; properties: Record<string, string> };
function fakeHubSpot(portals: Record<string, string>) {
  // token -> hubId
  const stores = new Map<string, Map<string, Map<string, Rec>>>(); // hubId -> type -> id -> rec
  const assoc: { hub: string; from: string; fromId: string; to: string; toId: string }[] = [];
  let next = 1000;
  const calls: { method: string; path: string }[] = [];
  const store = (hub: string, type: string) => {
    if (!stores.has(hub)) stores.set(hub, new Map());
    const s = stores.get(hub)!;
    if (!s.has(type)) s.set(type, new Map());
    return s.get(type)!;
  };
  const json = (status: number, body?: unknown) => new Response(body === undefined ? null : JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

  const fetchImpl = async (url: string | URL | Request, init?: RequestInit) => {
    const u = new URL(String(url));
    const method = init?.method ?? "GET";
    calls.push({ method, path: u.pathname });
    const token = String((init?.headers as any)?.Authorization ?? "").replace("Bearer ", "");
    const hub = portals[token];
    if (!hub) return json(401, { message: "Authentication credentials not found." });
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    const parts = u.pathname.split("/").filter(Boolean);

    if (u.pathname === "/account-info/v3/details") return json(200, { portalId: Number(hub), accountType: "STANDARD", uiDomain: "app.hubspot.com" });

    // /crm/v3/objects/{type}/search
    if (parts[0] === "crm" && parts[1] === "v3" && parts[2] === "objects") {
      const type = parts[3];
      const s = store(hub, type);
      if (parts[4] === "search") {
        const f = body.filterGroups?.[0]?.filters ?? [];
        const results = [...s.values()].filter((r) => f.every((x: any) => x.operator !== "EQ" || (r.properties[x.propertyName] ?? "").toLowerCase() === String(x.value).toLowerCase()));
        return json(200, { total: results.length, results });
      }
      if (parts[4] === "batch") return json(200, { results: body.inputs.map((i: any) => s.get(i.id)).filter(Boolean) });
      if (parts.length === 4 && method === "POST") {
        const r = { id: String(next++), properties: { ...body.properties } };
        s.set(r.id, r);
        return json(201, r);
      }
      const r = s.get(parts[4]);
      if (!r) return json(404, { message: "Object not found" });
      if (method === "PATCH") {
        Object.assign(r.properties, body.properties);
        return json(200, r);
      }
      return json(200, r);
    }
    if (parts[0] === "crm" && parts[1] === "v4" && parts[2] === "objects") {
      const [, , , from, fromId, , kind, to, toId] = parts;
      if (method === "PUT" && kind === "default") {
        assoc.push({ hub, from, fromId, to, toId });
        return json(200, {});
      }
      // list associations: /crm/v4/objects/{from}/{id}/associations/{to}
      const toType = parts[6];
      const results = assoc.filter((a) => a.hub === hub && ((a.to === from && a.toId === fromId && a.from === toType) || (a.from === from && a.fromId === fromId && a.to === toType)))
        .map((a) => ({ toObjectId: a.from === toType ? a.fromId : a.toId }));
      return json(200, { results });
    }
    return json(404, { message: `unhandled ${method} ${u.pathname}` });
  };
  return { fetchImpl: fetchImpl as typeof fetch, store, calls, assoc };
}

const ENV = {
  HS_TOKEN_NEWDAWN: "tok-nd",
  HS_PORTAL_ID_NEWDAWN: "246454273",
  HS_TOKEN_CLAY: "tok-clay",
  HS_PORTAL_ID_CLAY: "111",
  HS_TOKEN_SQG: "tok-sqg",
  HS_PORTAL_ID_SQG: "222",
};

let hs: ReturnType<typeof fakeHubSpot>;
let svc: Service;
beforeEach(() => {
  for (const [k, v] of Object.entries(ENV)) vi.stubEnv(k, v);
  vi.spyOn(console, "log").mockImplementation(() => {});
  hs = fakeHubSpot({ "tok-nd": "246454273", "tok-clay": "111", "tok-sqg": "222" });
  svc = new Service(hs.fetchImpl);
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("domain helpers", () => {
  it("extracts domains", () => {
    expect(domainOf("Ann@Hologic.com")).toBe("hologic.com");
    expect(domainOf("https://www.hologic.com/x")).toBe("hologic.com");
    expect(domainOf("hologic.com")).toBe("hologic.com");
  });
  it("blocks subdomains too", () => {
    expect(isBlockedDomain("eu.hologic.com", ["hologic.com"])).toBe(true);
    expect(isBlockedDomain("nothologic.com", ["hologic.com"])).toBe(false);
  });
});

describe("portal verification", () => {
  it("marks unconfigured portals unavailable without breaking the others", async () => {
    const r = await svc.listPortals();
    for (const k of ["ndconsulting", "korma", "viola"]) expect(r.find((p) => p.portal === k)!.status).toBe("unavailable");
    expect(r.find((p) => p.portal === "sqg")!.status).toBe("ok");
  });

  it("lists all portals as ok when tokens match", async () => {
    const r = await svc.listPortals();
    const ok = Object.fromEntries(r.map((p) => [p.portal, p.status]));
    expect(ok).toMatchObject({ newdawn: "ok", clay: "ok", sqg: "ok" });
    expect(r.map((p) => p.portal)).toEqual(["newdawn", "ndconsulting", "sqg", "korma", "viola", "clay"]);
  });

  it("disables a portal whose token belongs to a different Hub ID (swapped tokens)", async () => {
    vi.stubEnv("HS_TOKEN_SQG", "tok-clay"); // Clay's token pasted into SQG's slot
    const r = await svc.listPortals();
    const sqg = r.find((p) => p.portal === "sqg")!;
    expect(sqg.status).toBe("unavailable");
    expect(sqg.problem).toMatch(/MISMATCH/);
    await expect(svc.search("sqg", "contacts", {})).rejects.toThrow(/MISMATCH/);
  });

  it("reports the real Hub ID when the expected ID is not set", async () => {
    vi.stubEnv("HS_PORTAL_ID_SQG", "");
    const r = await svc.listPortals();
    expect(r.find((p) => p.portal === "sqg")!.problem).toMatch(/HS_PORTAL_ID_SQG=222/);
  });

  it("marks a portal unavailable with no token", async () => {
    vi.stubEnv("HS_TOKEN_CLAY", "");
    const r = await svc.listPortals();
    expect(r.find((p) => p.portal === "clay")!.problem).toMatch(/No access token/);
  });

  it("rejects unknown portals", async () => {
    await expect(svc.search("notaportal", "contacts", {})).rejects.toThrow(/Unknown portal/);
  });
});

describe("write guardrails", () => {
  it("refuses a write when confirm_portal does not match", async () => {
    await expect(svc.createRecord("sqg", "newdawn", "contacts", { email: "a@b.com" })).rejects.toThrow(GuardrailError);
    await expect(svc.createRecord("sqg", undefined, "contacts", { email: "a@b.com" })).rejects.toThrow(/confirm_portal/);
    expect(hs.calls.filter((c) => c.method === "POST" && c.path === "/crm/v3/objects/contacts")).toHaveLength(0);
  });

  it("refuses hologic.com contacts in the insurance portals but allows them in sqg", async () => {
    await expect(svc.createRecord("newdawn", "newdawn", "contacts", { email: "pat@hologic.com" })).rejects.toThrow(/blocked/);
    await expect(svc.createRecord("clay", "clay", "contacts", { email: "pat@HOLOGIC.com" })).rejects.toThrow(/blocked/);
    await expect(svc.createRecord("newdawn", "newdawn", "companies", { domain: "www.hologic.com", name: "Hologic" })).rejects.toThrow(/blocked/);
    const ok = await svc.createRecord("sqg", "sqg", "contacts", { email: "pat@hologic.com" });
    expect(ok.created).toBe(true);
  });

  it("honors extra blocked domains from env", async () => {
    vi.stubEnv("BLOCKED_DOMAINS_SQG", "example.org");
    await expect(svc.createRecord("sqg", "sqg", "contacts", { email: "x@example.org" })).rejects.toThrow(/blocked/);
  });

  it("find-or-create never overwrites an existing contact", async () => {
    const first = await svc.createRecord("sqg", "sqg", "contacts", { email: "ann@acme.com", firstname: "Ann" });
    const second = await svc.createRecord("sqg", "sqg", "contacts", { email: "ann@acme.com", firstname: "CHANGED" });
    expect(second.created).toBe(false);
    expect(second.record.id).toBe(first.record.id);
    expect(hs.store("222", "contacts").get(first.record.id)!.properties.firstname).toBe("Ann");
  });

  it("refuses to write to a record ID from another portal", async () => {
    const nd = await svc.createRecord("newdawn", "newdawn", "contacts", { email: "client@x.com" });
    const id = nd.record.id;
    await expect(svc.createNote("sqg", "sqg", "contacts", id, "hi")).rejects.toThrow(/different portal/);
    await expect(svc.updateRecord("sqg", "sqg", "contacts", id, { firstname: "X" })).rejects.toThrow(/different portal/);
    await expect(svc.associate("sqg", "sqg", "contacts", id, "companies", "999999")).rejects.toThrow(/different portal/);
  });

  it("refuses a note on an existing blocked-domain contact", async () => {
    // seeded directly, as if it predates the connector
    hs.store("246454273", "contacts").set("55", { id: "55", properties: { email: "old@hologic.com" } });
    await expect(svc.createNote("newdawn", "newdawn", "contacts", "55", "note")).rejects.toThrow(/blocked/);
    await expect(svc.createTask("newdawn", "newdawn", { subject: "x", dueDate: "2026-11-05", relatedType: "contacts", relatedId: "55" })).rejects.toThrow(/blocked/);
  });

  it("refuses to change an email to a blocked domain", async () => {
    const c = await svc.createRecord("clay", "clay", "contacts", { email: "a@ok.com" });
    await expect(svc.updateRecord("clay", "clay", "contacts", c.record.id, { email: "a@hologic.com" })).rejects.toThrow(/blocked/);
  });

  it("update returns before/after for named properties only", async () => {
    const c = await svc.createRecord("sqg", "sqg", "contacts", { email: "b@acme.com", jobtitle: "QA" });
    const u = await svc.updateRecord("sqg", "sqg", "contacts", c.record.id, { jobtitle: "Director QA" });
    expect(u.changes).toEqual([{ property: "jobtitle", before: "QA", after: "Director QA" }]);
  });

  it("creates and reads back notes and tasks, tagged with the portal", async () => {
    const c = await svc.createRecord("sqg", "sqg", "contacts", { email: "c@acme.com" });
    const n = await svc.createNote("sqg", "sqg", "contacts", c.record.id, "Intro call went well");
    expect(n.tag).toBe("[portal: sqg — Software Quality Guru]");
    const notes = await svc.getNotes("sqg", "contacts", c.record.id);
    expect(notes.notes.map((x) => x.body)).toEqual(["Intro call went well"]);
    const t = await svc.createTask("sqg", "sqg", { subject: "Follow up", dueDate: "2026-11-05", relatedType: "contacts", relatedId: c.record.id });
    expect(t.relatedTo?.id).toBe(c.record.id);
    await expect(svc.createTask("sqg", "sqg", { subject: "x", dueDate: "not a date" })).rejects.toThrow(/valid date/);
  });

  it("rejects non-numeric record IDs", async () => {
    await expect(svc.getRecord("sqg", "contacts", "../../account")).rejects.toThrow(/valid HubSpot record ID/);
  });

  it("writes an audit line with IDs only", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    await svc.createRecord("sqg", "sqg", "contacts", { email: "secret@acme.com", firstname: "Secret" });
    const line = JSON.parse(String(log.mock.calls.at(-1)![0]));
    expect(line).toMatchObject({ audit: true, portal: "sqg", tool: "create_record", outcome: "ok" });
    expect(JSON.stringify(line)).not.toMatch(/secret@acme|Secret/);
  });
});

describe("find_across_portals", () => {
  it("shows which portal a contact lives in", async () => {
    await svc.createRecord("clay", "clay", "contacts", { email: "medicare@client.com" });
    const r = await svc.findAcrossPortals({ email: "medicare@client.com" });
    const hits = Object.fromEntries(r.results.map((p: any) => [p.portal, p.matches?.length ?? 0]));
    expect(hits).toMatchObject({ newdawn: 0, clay: 1, sqg: 0 });
  });
});

describe("rate limiting", () => {
  it("retries on 429", async () => {
    let n = 0;
    const inner = hs.fetchImpl;
    const flaky = (async (u: any, i: any) => (n++ === 1 ? new Response("{}", { status: 429, headers: { "retry-after": "0" } }) : inner(u, i))) as typeof fetch;
    const s2 = new Service(flaky);
    const r = await s2.search("sqg", "contacts", {});
    expect(r.total).toBe(0);
    expect(n).toBe(3); // verify + 429 + retry
  });
});
