import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { HubSpotError } from "./hubspot";
import { GuardrailError, PORTAL_KEYS, PORTALS } from "./portals";
import { ASSOC_TYPES, READ_TYPES, Service, WRITE_TYPES } from "./service";

const portalList = PORTALS.map((p) => `"${p.key}" = ${p.label}`).join("; ");

const portal = z
  .enum(PORTAL_KEYS)
  .describe(`Which HubSpot portal to use. Required, no default. ${portalList}. If unsure which portal the user means, ASK before calling.`);
const confirmPortal = z
  .string()
  .describe("Must repeat the exact `portal` value. A deliberate second confirmation that this write belongs in that portal.");
const recordId = z.string().regex(/^\d+$/).describe("HubSpot record ID (numeric).");
const propertyMap = z.record(z.string(), z.string()).describe('HubSpot property internal names to string values, e.g. {"email":"a@b.com","firstname":"Ann"}.');

const READ = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true } as const;
const WRITE = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true } as const;

type Result = { content: { type: "text"; text: string }[]; isError?: boolean };

async function run(fn: () => Promise<unknown>): Promise<Result> {
  try {
    const out: any = await fn();
    const tag = out && typeof out === "object" && "tag" in out ? `${out.tag}\n` : "";
    if (tag) delete out.tag;
    return { content: [{ type: "text", text: `${tag}${JSON.stringify(out, null, 2)}` }] };
  } catch (e) {
    const msg = e instanceof GuardrailError || e instanceof HubSpotError ? e.message : `Unexpected error: ${(e as Error).message}`;
    if (!(e instanceof GuardrailError)) console.error(e);
    return { isError: true, content: [{ type: "text", text: msg }] };
  }
}

const userOf = (ctx: any) => ({ user: ctx?.http?.authInfo?.extra?.user as string | undefined });

export function registerTools(server: McpServer, svc: Service) {
  // ─── reads ──────────────────────────────────────────────────────────────
  server.registerTool(
    "list_portals",
    {
      title: "List HubSpot portals",
      description: "List every configured HubSpot portal with its Hub ID, health (token valid and matches the expected portal), write permission and blocked domains.",
      inputSchema: z.object({}),
      annotations: READ,
    },
    async () => run(() => svc.listPortals().then((portals) => ({ portals }))),
  );

  server.registerTool(
    "search_records",
    {
      title: "Search records",
      description: "Search contacts, companies, deals, tickets or tasks in ONE portal by free text and/or property filters. Use list_properties to find exact property names.",
      inputSchema: z.object({
        portal,
        objectType: z.enum(READ_TYPES),
        query: z.string().max(200).optional().describe("Free-text search over the object's default searchable fields."),
        filters: z
          .array(
            z.object({
              property: z.string(),
              operator: z.enum(["EQ", "NEQ", "LT", "LTE", "GT", "GTE", "BETWEEN", "IN", "NOT_IN", "HAS_PROPERTY", "NOT_HAS_PROPERTY", "CONTAINS_TOKEN", "NOT_CONTAINS_TOKEN"]),
              value: z.string().optional(),
              highValue: z.string().optional().describe("Upper bound for BETWEEN."),
              values: z.array(z.string()).optional().describe("For IN / NOT_IN."),
            }),
          )
          .max(6)
          .optional()
          .describe("All filters are ANDed."),
        properties: z.array(z.string()).optional().describe("Properties to return; sensible defaults if omitted."),
        sortBy: z.string().optional(),
        sortDirection: z.enum(["ASCENDING", "DESCENDING"]).optional(),
        limit: z.number().int().min(1).max(100).optional(),
        after: z.string().optional().describe("Paging cursor from a previous call's nextAfter."),
      }),
      annotations: READ,
    },
    async (a) => run(() => svc.search(a.portal, a.objectType, a)),
  );

  server.registerTool(
    "get_record",
    {
      title: "Get record",
      description: "Get one record from ONE portal, with chosen properties and associated record IDs.",
      inputSchema: z.object({
        portal,
        objectType: z.enum(READ_TYPES),
        id: recordId,
        properties: z.array(z.string()).optional(),
        associations: z.array(z.enum(["contacts", "companies", "deals", "tickets", "notes", "tasks"])).optional(),
      }),
      annotations: READ,
    },
    async (a) => run(() => svc.getRecord(a.portal, a.objectType, a.id, a.properties, a.associations)),
  );

  server.registerTool(
    "list_properties",
    {
      title: "List properties",
      description: "List property definitions (internal name, label, type, allowed values) for an object type in ONE portal.",
      inputSchema: z.object({ portal, objectType: z.enum(READ_TYPES), nameContains: z.string().optional().describe("Filter by name/label substring.") }),
      annotations: READ,
    },
    async (a) => run(() => svc.listProperties(a.portal, a.objectType, a.nameContains)),
  );

  server.registerTool(
    "list_pipelines",
    {
      title: "List pipelines",
      description: "List deal or ticket pipelines and their stage IDs in ONE portal.",
      inputSchema: z.object({ portal, objectType: z.enum(["deals", "tickets"]) }),
      annotations: READ,
    },
    async (a) => run(() => svc.listPipelines(a.portal, a.objectType)),
  );

  server.registerTool(
    "get_notes",
    {
      title: "Get notes",
      description: "Read the notes attached to a record in ONE portal, newest first.",
      inputSchema: z.object({ portal, objectType: z.enum(ASSOC_TYPES), id: recordId, limit: z.number().int().min(1).max(100).optional() }),
      annotations: READ,
    },
    async (a) => run(() => svc.getNotes(a.portal, a.objectType, a.id, a.limit)),
  );

  server.registerTool(
    "find_across_portals",
    {
      title: "Find across all portals",
      description: "READ-ONLY lookup of a contact email, company domain or company name in EVERY portal at once. Use it to answer 'which business does this person/company belong to?' before writing anything.",
      inputSchema: z.object({
        email: z.string().optional(),
        domain: z.string().optional(),
        companyName: z.string().optional(),
      }),
      annotations: READ,
    },
    async (a) => run(() => svc.findAcrossPortals(a)),
  );

  // ─── writes ─────────────────────────────────────────────────────────────
  server.registerTool(
    "create_record",
    {
      title: "Create record (find-or-create)",
      description:
        "Create a contact, company, deal or ticket in ONE portal. Contacts are matched by email and companies by domain: if one exists it is returned UNCHANGED (never overwritten). Requires confirm_portal.",
      inputSchema: z.object({ portal, confirm_portal: confirmPortal, objectType: z.enum(WRITE_TYPES), properties: propertyMap }),
      annotations: WRITE,
    },
    async (a, ctx) => run(() => svc.createRecord(a.portal, a.confirm_portal, a.objectType, a.properties, userOf(ctx))),
  );

  server.registerTool(
    "update_record",
    {
      title: "Update record",
      description: "Change only the named properties on one record in ONE portal. Returns before/after values. Requires confirm_portal.",
      inputSchema: z.object({ portal, confirm_portal: confirmPortal, objectType: z.enum(WRITE_TYPES), id: recordId, properties: propertyMap }),
      annotations: WRITE,
    },
    async (a, ctx) => run(() => svc.updateRecord(a.portal, a.confirm_portal, a.objectType, a.id, a.properties, userOf(ctx))),
  );

  server.registerTool(
    "create_note",
    {
      title: "Create note",
      description: "Attach a note to a record in ONE portal. Requires confirm_portal.",
      inputSchema: z.object({ portal, confirm_portal: confirmPortal, objectType: z.enum(ASSOC_TYPES), id: recordId, body: z.string().min(1).max(60000) }),
      annotations: WRITE,
    },
    async (a, ctx) => run(() => svc.createNote(a.portal, a.confirm_portal, a.objectType, a.id, a.body, userOf(ctx))),
  );

  server.registerTool(
    "create_task",
    {
      title: "Create task",
      description: "Create a follow-up task (optionally linked to a record) in ONE portal. Requires confirm_portal.",
      inputSchema: z.object({
        portal,
        confirm_portal: confirmPortal,
        subject: z.string().min(1).max(500),
        body: z.string().max(60000).optional(),
        dueDate: z.string().describe("YYYY-MM-DD or ISO timestamp."),
        priority: z.enum(["LOW", "MEDIUM", "HIGH"]).optional(),
        relatedType: z.enum(ASSOC_TYPES).optional(),
        relatedId: recordId.optional(),
      }),
      annotations: WRITE,
    },
    async (a, ctx) => run(() => svc.createTask(a.portal, a.confirm_portal, a, userOf(ctx))),
  );

  server.registerTool(
    "associate",
    {
      title: "Associate records",
      description: "Link two records that are both in the SAME portal (default association type). Requires confirm_portal.",
      inputSchema: z.object({
        portal,
        confirm_portal: confirmPortal,
        fromType: z.enum(ASSOC_TYPES),
        fromId: recordId,
        toType: z.enum(ASSOC_TYPES),
        toId: recordId,
      }),
      annotations: WRITE,
    },
    async (a, ctx) => run(() => svc.associate(a.portal, a.confirm_portal, a.fromType, a.fromId, a.toType, a.toId, userOf(ctx))),
  );
}
