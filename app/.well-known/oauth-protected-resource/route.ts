import { getPublicOrigin, metadataCorsOptionsRequestHandler, protectedResourceHandler } from "mcp-handler";
import { authIssuer } from "@/lib/auth";

// RFC 9728 Protected Resource Metadata. The protected resource is the /mcp endpoint.
function handler(req: Request) {
  const issuer = authIssuer();
  if (!issuer) return Response.json({ error: "AUTH_ISSUER is not configured" }, { status: 503 });
  return protectedResourceHandler({ authServerUrls: [issuer], resourceUrl: `${getPublicOrigin(req)}/mcp` })(req);
}

export { handler as GET };
export const OPTIONS = metadataCorsOptionsRequestHandler();
