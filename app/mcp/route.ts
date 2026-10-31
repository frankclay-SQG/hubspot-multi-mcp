import { createMcpHandler, withMcpAuth } from "mcp-handler";
import { verifyToken } from "@/lib/auth";
import { Service } from "@/lib/service";
import { registerTools } from "@/lib/tools";

export const runtime = "nodejs";
export const maxDuration = 60;

const svc = new Service();

const handler = createMcpHandler((server) => registerTools(server, svc), {
  serverInfo: { name: "hubspot-multi-portal", version: "0.1.0" },
  instructions:
    "Multi-portal HubSpot access. Every tool takes a required `portal`. Never guess the portal: use the one the user or the Project instructions name, " +
    "and ask if it is unclear. Use find_across_portals (read-only) to see where a person or company already lives. " +
    "Write tools also need `confirm_portal` equal to `portal`. Never copy records between portals. Responses begin with a [portal: …] tag; mention it to the user when you write.",
});

const authed = withMcpAuth(handler, verifyToken, { required: true });

export { authed as GET, authed as POST, authed as DELETE };
