/**
 * OAuth bearer-token verification for the /mcp endpoint.
 *
 * Provider-agnostic: works with any OAuth authorization server that issues
 * JWT access tokens and publishes a JWKS (WorkOS AuthKit, Clerk, Auth0, ...).
 *
 * Env:
 *   AUTH_ISSUER       issuer URL of the authorization server (required)
 *   AUTH_JWKS_URL     optional; discovered from the issuer's metadata if unset
 *   AUTH_AUDIENCE     optional; expected `aud` claim
 *   ALLOWED_SUBJECTS  comma-separated `sub` values allowed in
 *   ALLOWED_EMAILS    comma-separated emails allowed in (if the token has an email claim)
 *
 * Fails closed: if no allow-list is configured, nobody gets in.
 * MCP_DEV_NO_AUTH=1 skips auth ONLY when not running on Vercel (local dev).
 */
import type { AuthInfo } from "@modelcontextprotocol/server";
import { createRemoteJWKSet, jwtVerify, type JWTPayload } from "jose";

const list = (v?: string) =>
  (v ?? "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);

export function devBypassEnabled() {
  return process.env.MCP_DEV_NO_AUTH === "1" && !process.env.VERCEL;
}

export function authIssuer(): string | undefined {
  return process.env.AUTH_ISSUER?.replace(/\/$/, "") || undefined;
}

let jwks: ReturnType<typeof createRemoteJWKSet> | undefined;
let jwksFor: string | undefined;

async function discoverJwksUrl(issuer: string): Promise<string> {
  if (process.env.AUTH_JWKS_URL) return process.env.AUTH_JWKS_URL;
  for (const path of ["/.well-known/oauth-authorization-server", "/.well-known/openid-configuration"]) {
    try {
      const res = await fetch(`${issuer}${path}`);
      if (res.ok) {
        const meta = (await res.json()) as { jwks_uri?: string };
        if (meta.jwks_uri) return meta.jwks_uri;
      }
    } catch {
      /* try next */
    }
  }
  throw new Error(`Could not discover jwks_uri for ${issuer}; set AUTH_JWKS_URL.`);
}

async function getJwks(issuer: string) {
  if (!jwks || jwksFor !== issuer) {
    jwks = createRemoteJWKSet(new URL(await discoverJwksUrl(issuer)));
    jwksFor = issuer;
  }
  return jwks;
}

export function isAllowed(payload: JWTPayload): boolean {
  const subs = list(process.env.ALLOWED_SUBJECTS);
  const emails = list(process.env.ALLOWED_EMAILS);
  if (!subs.length && !emails.length) return false; // fail closed
  const sub = String(payload.sub ?? "").toLowerCase();
  const email = String((payload as any).email ?? "").toLowerCase();
  return (!!sub && subs.includes(sub)) || (!!email && emails.includes(email));
}

export async function verifyToken(_req: Request, bearer?: string): Promise<AuthInfo | undefined> {
  if (devBypassEnabled()) {
    return { token: "dev", clientId: "dev", scopes: [], extra: { user: "local-dev" } };
  }
  const issuer = authIssuer();
  if (!issuer || !bearer) return undefined;
  try {
    const { payload } = await jwtVerify(bearer, await getJwks(issuer), {
      issuer: [issuer, `${issuer}/`],
      audience: process.env.AUTH_AUDIENCE || undefined,
    });
    if (!isAllowed(payload)) {
      // Logged so the owner can find their own `sub` on first connect.
      console.warn(JSON.stringify({ auth: "denied", sub: payload.sub, email: (payload as any).email ?? null }));
      return undefined;
    }
    const scope = (payload as any).scope;
    return {
      token: bearer,
      clientId: String((payload as any).azp ?? (payload as any).client_id ?? "unknown"),
      scopes: typeof scope === "string" ? scope.split(" ").filter(Boolean) : [],
      expiresAt: payload.exp,
      extra: { user: String((payload as any).email ?? payload.sub) },
    };
  } catch (e) {
    console.warn(JSON.stringify({ auth: "invalid_token", reason: (e as Error).message }));
    return undefined;
  }
}
