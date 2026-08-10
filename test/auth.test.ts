import { describe, expect, it } from "vitest";
import { authenticateCaller, requireScope } from "../src/core/auth";
import { RouterError } from "../src/core/types";

const secret = "a".repeat(48);
describe("caller authentication", () => {
  it("derives trusted caller identity and scopes from a hashed key registry", async () => {
    const caller = await authenticateCaller(new Request("https://router.test/v1/models", {
      headers: { authorization: `Bearer brk_local-laptop.${secret}` },
    }), { CALLER_CREDENTIALS_JSON: await registry() });
    expect(caller.id).toBe("local-laptop");
    expect(caller.environment).toBe("production");
    expect(caller.scopes.has("chat:write")).toBe(true);
  });

  it("does not fall back to a legacy key when a caller registry is configured", async () => {
    await expect(authenticateCaller(new Request("https://router.test", {
      headers: { authorization: "Bearer old-key" },
    }), { CALLER_CREDENTIALS_JSON: await registry(), ROUTER_API_KEY: "old-key" })).rejects.toMatchObject({ status: 401 });
  });

  it("rejects a valid caller that lacks the endpoint scope", async () => {
    const caller = await authenticateCaller(new Request("https://router.test", {
      headers: { authorization: `Bearer brk_local-laptop.${secret}` },
    }), { CALLER_CREDENTIALS_JSON: await registry() });
    expect(() => requireScope(caller, "jobs:write")).toThrow(RouterError);
  });
});

async function registry(): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(secret));
  const keyHash = [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  return JSON.stringify({
    "local-laptop": {
      keyHash,
      environment: "production",
      scopes: ["models:read", "chat:write"],
    },
  });
}
