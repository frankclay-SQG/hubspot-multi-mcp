import { describe, expect, it, vi } from "vitest";
import { provision } from "../provisioning/korma/provision.mjs";
import { PIPELINES, PROPERTIES } from "../provisioning/korma/definitions.mjs";

/** Fake HubSpot schema API: groups, properties, deal pipelines for one portal. */
function fakePortal(hubId: string, seed: { props?: Record<string, any[]>; pipelines?: any[] } = {}) {
  const groups: Record<string, any[]> = { contacts: [], companies: [], deals: [] };
  const props: Record<string, any[]> = { contacts: [], companies: [], deals: [], ...(seed.props ?? {}) };
  const pipelines: any[] = [...(seed.pipelines ?? [])];
  const calls: string[] = [];
  const json = (status: number, body?: unknown) => new Response(body === undefined ? "" : JSON.stringify(body), { status });
  const fetchImpl = (async (url: string, init: RequestInit = {}) => {
    const u = new URL(url);
    const method = init.method ?? "GET";
    const body = init.body ? JSON.parse(String(init.body)) : undefined;
    calls.push(`${method} ${u.pathname}`);
    const p = u.pathname.split("/").filter(Boolean);
    if (u.pathname === "/account-info/v3/details") return json(200, { portalId: Number(hubId), accountType: "STANDARD" });
    if (p[1] === "v3" && p[2] === "properties") {
      const obj = p[3];
      if (p[4] === "groups") {
        if (method === "POST") return groups[obj].push(body), json(201, body);
        return json(200, { results: groups[obj] });
      }
      if (method === "POST") return props[obj].push(body), json(201, body);
      if (method === "PATCH") {
        const cur = props[obj].find((x) => x.name === p[4]);
        Object.assign(cur, body);
        return json(200, cur);
      }
      return json(200, { results: props[obj] });
    }
    if (u.pathname === "/crm/v3/pipelines/deals") {
      if (method === "POST") return pipelines.push(body), json(201, body);
      return json(200, { results: pipelines });
    }
    return json(404, { message: "unhandled" });
  }) as typeof fetch;
  return { fetchImpl, groups, props, pipelines, calls };
}

const quiet = () => {};

describe("KORMA provisioning", () => {
  it("dry run changes nothing and plans everything", async () => {
    const f = fakePortal("555");
    const r = await provision({ token: "t", fetchImpl: f.fetchImpl, log: quiet });
    expect(f.calls.filter((c) => !c.startsWith("GET"))).toEqual([]);
    expect(r.actions.filter((a: any) => a.kind === "create property")).toHaveLength(114);
    expect(r.actions.filter((a: any) => a.kind === "create pipeline")).toHaveLength(5);
  });

  it("refuses --apply without an expected portal, and with the wrong one", async () => {
    const f = fakePortal("555");
    await expect(provision({ token: "t", apply: true, fetchImpl: f.fetchImpl, log: quiet })).rejects.toThrow(/expect-portal/);
    await expect(provision({ token: "t", apply: true, expectPortal: "999", fetchImpl: f.fetchImpl, log: quiet })).rejects.toThrow(/not 999/);
    expect(f.calls.filter((c) => !c.startsWith("GET"))).toEqual([]);
  });

  it("apply creates everything once, and a second run is a no-op", async () => {
    const f = fakePortal("555");
    const r1 = await provision({ token: "t", apply: true, expectPortal: "555", fetchImpl: f.fetchImpl, log: quiet });
    expect(r1.errors).toEqual([]);
    expect(f.props.contacts).toHaveLength(PROPERTIES.contacts.length);
    expect(f.pipelines).toHaveLength(PIPELINES.length);
    const before = f.calls.length;
    const r2 = await provision({ token: "t", apply: true, expectPortal: "555", fetchImpl: f.fetchImpl, log: quiet });
    expect(r2.actions).toEqual([]);
    expect(f.calls.slice(before).every((c) => c.startsWith("GET"))).toBe(true);
  });

  it("keeps existing korma_inquiry_type options and only adds the new ones", async () => {
    const existing = {
      name: "korma_inquiry_type",
      type: "enumeration",
      fieldType: "select",
      options: [
        { label: "Regular class", value: "regular_class", displayOrder: 0 },
        { label: "Seminar", value: "seminar", displayOrder: 1 },
        { label: "Certification", value: "certification", displayOrder: 2 },
      ],
    };
    const f = fakePortal("555", { props: { contacts: [existing] } });
    await provision({ token: "t", apply: true, expectPortal: "555", fetchImpl: f.fetchImpl, log: quiet });
    const values = f.props.contacts.find((p) => p.name === "korma_inquiry_type").options.map((o: any) => o.value);
    expect(values).toEqual(["regular_class", "seminar", "certification", "enrollment", "homeschool", "general"]);
  });

  it("reports a type conflict instead of changing an existing property", async () => {
    const f = fakePortal("555", { props: { contacts: [{ name: "date_of_birth", type: "string", fieldType: "text" }] } });
    const r = await provision({ token: "t", apply: true, expectPortal: "555", fetchImpl: f.fetchImpl, log: vi.fn() });
    expect(r.conflicts).toEqual([expect.objectContaining({ label: "contacts.date_of_birth", existing: "string/text", wanted: "date/date" })]);
    expect(f.calls).not.toContain("PATCH /crm/v3/properties/contacts/date_of_birth");
  });
});
