import { afterEach, describe, expect, it, vi } from "vitest";
import { devBypassEnabled, isAllowed, verifyToken } from "@/lib/auth";

afterEach(() => vi.unstubAllEnvs());

describe("auth allow-list", () => {
  it("fails closed when no allow-list is configured", () => {
    vi.stubEnv("ALLOWED_SUBJECTS", "");
    vi.stubEnv("ALLOWED_EMAILS", "");
    expect(isAllowed({ sub: "user_1", email: "frank@softwarequality.guru" } as any)).toBe(false);
  });
  it("allows a listed subject or email, case-insensitively", () => {
    vi.stubEnv("ALLOWED_SUBJECTS", "user_ABC");
    vi.stubEnv("ALLOWED_EMAILS", "Frank@SoftwareQuality.guru");
    expect(isAllowed({ sub: "user_abc" })).toBe(true);
    expect(isAllowed({ sub: "other", email: "frank@softwarequality.guru" } as any)).toBe(true);
    expect(isAllowed({ sub: "other", email: "someone@else.com" } as any)).toBe(false);
  });
  it("never allows the dev bypass on Vercel", () => {
    vi.stubEnv("MCP_DEV_NO_AUTH", "1");
    vi.stubEnv("VERCEL", "1");
    expect(devBypassEnabled()).toBe(false);
  });
  it("rejects requests with no bearer token", async () => {
    vi.stubEnv("MCP_DEV_NO_AUTH", "");
    vi.stubEnv("AUTH_ISSUER", "https://auth.example.com");
    expect(await verifyToken(new Request("https://x/mcp"), undefined)).toBeUndefined();
  });
  it("rejects garbage tokens", async () => {
    vi.stubEnv("MCP_DEV_NO_AUTH", "");
    vi.stubEnv("AUTH_ISSUER", "https://auth.example.com");
    vi.stubEnv("AUTH_JWKS_URL", "https://auth.example.com/jwks");
    vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(await verifyToken(new Request("https://x/mcp"), "not-a-jwt")).toBeUndefined();
  });
});
