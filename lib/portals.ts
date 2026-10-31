/**
 * Portal registry.
 *
 * Each HubSpot portal is listed here once. Secrets never live in this file:
 * the access token comes from the env var named in `tokenEnv`, and the
 * expected Hub ID comes from `portalIdEnv` (or `portalId` when it is known
 * and not sensitive).
 *
 * To add a portal: add an entry below, set its env vars in Vercel, redeploy.
 */

export interface PortalConfig {
  /** Short name used in every tool call, e.g. "sqg". */
  key: string;
  /** Human-readable name shown in every response. */
  label: string;
  /** Env var holding the HubSpot private-app / static access token. */
  tokenEnv: string;
  /** Env var holding the expected Hub ID (portal ID). */
  portalIdEnv: string;
  /** Hard-coded expected Hub ID, used when the env var is not set. */
  portalId?: string;
  /** If false, every write tool refuses for this portal. */
  writesAllowed: boolean;
  /**
   * Email / website domains that must never be written into this portal
   * (contacts by email domain, companies by domain).
   */
  blockedDomains: string[];
}

export const PORTALS: PortalConfig[] = [
  {
    key: "newdawn",
    label: "New Dawn Insurance Agency",
    tokenEnv: "HS_TOKEN_NEWDAWN",
    portalIdEnv: "HS_PORTAL_ID_NEWDAWN",
    portalId: "246454273",
    writesAllowed: true,
    blockedDomains: ["hologic.com"],
  },
  {
    key: "clay",
    label: "Clay Agency",
    tokenEnv: "HS_TOKEN_CLAY",
    portalIdEnv: "HS_PORTAL_ID_CLAY",
    writesAllowed: true,
    blockedDomains: ["hologic.com"],
  },
  {
    key: "sqg",
    label: "Software Quality Guru",
    tokenEnv: "HS_TOKEN_SQG",
    portalIdEnv: "HS_PORTAL_ID_SQG",
    writesAllowed: true,
    blockedDomains: [],
  },
];

/** Extra blocked domains per portal from env, e.g. BLOCKED_DOMAINS_NEWDAWN="a.com,b.com". */
function extraBlocked(key: string): string[] {
  const raw = process.env[`BLOCKED_DOMAINS_${key.toUpperCase()}`] ?? "";
  return raw
    .split(",")
    .map((d) => d.trim().toLowerCase())
    .filter(Boolean);
}

export interface ResolvedPortal extends PortalConfig {
  token?: string;
  expectedPortalId?: string;
}

export function resolvePortal(cfg: PortalConfig): ResolvedPortal {
  return {
    ...cfg,
    blockedDomains: [...cfg.blockedDomains.map((d) => d.toLowerCase()), ...extraBlocked(cfg.key)],
    token: process.env[cfg.tokenEnv] || undefined,
    expectedPortalId: process.env[cfg.portalIdEnv] || cfg.portalId,
  };
}

export const PORTAL_KEYS = PORTALS.map((p) => p.key) as [string, ...string[]];

export function getPortal(key: string): ResolvedPortal {
  const cfg = PORTALS.find((p) => p.key === key);
  if (!cfg) throw new GuardrailError(`Unknown portal "${key}". Valid portals: ${PORTAL_KEYS.join(", ")}.`);
  return resolvePortal(cfg);
}

export function allPortals(): ResolvedPortal[] {
  return PORTALS.map(resolvePortal);
}

/** Error whose message is safe and meant to be shown to the user. */
export class GuardrailError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GuardrailError";
  }
}

export function portalTag(p: Pick<PortalConfig, "key" | "label">): string {
  return `[portal: ${p.key} — ${p.label}]`;
}
