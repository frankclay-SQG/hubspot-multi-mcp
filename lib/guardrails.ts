import { GuardrailError, type ResolvedPortal } from "./portals";

/** Lower-cased domain from an email address or URL/domain string, or undefined. */
export function domainOf(value: string | undefined | null): string | undefined {
  if (!value) return undefined;
  const v = value.trim().toLowerCase();
  if (v.includes("@")) return v.split("@").pop() || undefined;
  try {
    const url = new URL(v.includes("://") ? v : `https://${v}`);
    return url.hostname.replace(/^www\./, "") || undefined;
  } catch {
    return undefined;
  }
}

/** True when `domain` equals a blocked domain or is a subdomain of one. */
export function isBlockedDomain(domain: string | undefined, blocked: string[]): boolean {
  if (!domain) return false;
  return blocked.some((b) => domain === b || domain.endsWith(`.${b}`));
}

/** Writes must name the portal twice: `portal` and `confirm_portal`. */
export function assertConfirmed(portal: string, confirmPortal: string | undefined) {
  if (confirmPortal !== portal) {
    throw new GuardrailError(
      `Write refused: confirm_portal ("${confirmPortal ?? ""}") must exactly match portal ("${portal}"). ` +
        `Re-check which HubSpot portal this belongs in before retrying.`,
    );
  }
}

export function assertWritable(p: ResolvedPortal) {
  if (!p.writesAllowed) throw new GuardrailError(`Write refused: writes are disabled for portal "${p.key}".`);
}

/** Refuse when any of the given emails/domains/URLs is on the portal's blocklist. */
export function assertNotBlocked(p: ResolvedPortal, values: (string | undefined | null)[]) {
  for (const v of values) {
    const d = domainOf(v);
    if (isBlockedDomain(d, p.blockedDomains)) {
      throw new GuardrailError(
        `Write refused: "${d}" is blocked for portal "${p.key}" (${p.label}). ` +
          `Records from this domain must not be stored in this portal.`,
      );
    }
  }
}

/** HubSpot record IDs are numeric strings. Rejects anything else early. */
export function assertRecordId(id: string) {
  if (!/^\d{1,20}$/.test(id)) throw new GuardrailError(`"${id}" is not a valid HubSpot record ID.`);
}
