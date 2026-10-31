/**
 * Write audit log. Emits one JSON line per write to stdout, which Vercel
 * keeps in its runtime logs (filter on "audit"). Records IDs only — never
 * names, emails, note bodies or other personal data.
 */
export interface AuditEntry {
  portal: string;
  tool: string;
  objectType?: string;
  recordId?: string;
  outcome: "ok" | "refused" | "error";
  detail?: string;
  user?: string;
}

export function audit(entry: AuditEntry) {
  console.log(JSON.stringify({ audit: true, at: new Date().toISOString(), ...entry }));
}
