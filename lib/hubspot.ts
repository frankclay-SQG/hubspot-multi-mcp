/**
 * Thin HubSpot REST client, one instance per portal token.
 * Retries on 429 (rate limit) and transient 5xx with backoff.
 */

const BASE = "https://api.hubapi.com";

export class HubSpotError extends Error {
  constructor(
    message: string,
    public status: number,
    public body?: unknown,
  ) {
    super(message);
    this.name = "HubSpotError";
  }
}

export type Fetch = typeof fetch;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class HubSpotClient {
  constructor(
    private token: string,
    private fetchImpl: Fetch = fetch,
    private maxRetries = 3,
  ) {}

  async request<T = any>(method: string, path: string, body?: unknown): Promise<T> {
    let attempt = 0;
    for (;;) {
      const res = await this.fetchImpl(`${BASE}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${this.token}`,
          "Content-Type": "application/json",
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });

      if ((res.status === 429 || res.status >= 500) && attempt < this.maxRetries) {
        const retryAfter = Number(res.headers.get("retry-after"));
        const wait = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 500 * 2 ** attempt;
        attempt++;
        await sleep(Math.min(wait, 10_000));
        continue;
      }

      if (res.status === 204) return undefined as T;
      const text = await res.text();
      let json: any;
      try {
        json = text ? JSON.parse(text) : undefined;
      } catch {
        json = text;
      }
      if (!res.ok) {
        const msg = (json && typeof json === "object" && json.message) || `HubSpot ${method} ${path} failed`;
        throw new HubSpotError(`${msg} (HTTP ${res.status})`, res.status, json);
      }
      return json as T;
    }
  }

  accountDetails() {
    return this.request<{ portalId: number; accountType?: string; timeZone?: string; uiDomain?: string; companyCurrency?: string }>(
      "GET",
      "/account-info/v3/details",
    );
  }

  search(objectType: string, body: unknown) {
    return this.request<{ total: number; results: any[]; paging?: { next?: { after: string } } }>(
      "POST",
      `/crm/v3/objects/${objectType}/search`,
      body,
    );
  }

  /** Returns null on 404 instead of throwing. */
  async get(objectType: string, id: string, properties: string[] = [], associations: string[] = []) {
    const qs = new URLSearchParams();
    if (properties.length) qs.set("properties", properties.join(","));
    if (associations.length) qs.set("associations", associations.join(","));
    try {
      return await this.request<any>(
        "GET",
        `/crm/v3/objects/${objectType}/${encodeURIComponent(id)}${qs.size ? `?${qs}` : ""}`,
      );
    } catch (e) {
      if (e instanceof HubSpotError && e.status === 404) return null;
      throw e;
    }
  }

  create(objectType: string, properties: Record<string, string>) {
    return this.request<any>("POST", `/crm/v3/objects/${objectType}`, { properties });
  }

  update(objectType: string, id: string, properties: Record<string, string>) {
    return this.request<any>("PATCH", `/crm/v3/objects/${objectType}/${encodeURIComponent(id)}`, { properties });
  }

  /** Associate two records using HubSpot's default association type. */
  associateDefault(fromType: string, fromId: string, toType: string, toId: string) {
    return this.request<any>(
      "PUT",
      `/crm/v4/objects/${fromType}/${encodeURIComponent(fromId)}/associations/default/${toType}/${encodeURIComponent(toId)}`,
    );
  }

  listAssociations(fromType: string, fromId: string, toType: string) {
    return this.request<{ results: { toObjectId: number | string }[] }>(
      "GET",
      `/crm/v4/objects/${fromType}/${encodeURIComponent(fromId)}/associations/${toType}?limit=100`,
    );
  }

  batchRead(objectType: string, ids: string[], properties: string[]) {
    return this.request<{ results: any[] }>("POST", `/crm/v3/objects/${objectType}/batch/read`, {
      inputs: ids.map((id) => ({ id })),
      properties,
    });
  }

  properties(objectType: string) {
    return this.request<{ results: any[] }>("GET", `/crm/v3/properties/${objectType}`);
  }

  pipelines(objectType: "deals" | "tickets") {
    return this.request<{ results: any[] }>("GET", `/crm/v3/pipelines/${objectType}`);
  }
}
