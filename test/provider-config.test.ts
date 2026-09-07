import { afterEach, describe, expect, it, vi } from "vitest";
import type { ProviderRateLimitSettings } from "../src/core/types";
import {
  configuredOpenAiCompatibleProviders, configuredProviderAccounts, providerForModel,
} from "../src/providers/openai-compatible";
import { registeredProviders } from "../src/adapters/cloudflare/provider-registry";
import type { Env } from "../src/config";

const defaults: ProviderRateLimitSettings = {
  dailySafetyBudgetTokens: 0,
  cooldownMs: 900_000,
  maxConcurrent: 1,
  reservationTtlMs: 120_000,
};

const model = {
  id: "free/default",
  upstreamModel: "free-model",
  contextWindow: 65_536,
  maxOutputTokens: 4_096,
  supports: { streaming: true, tools: true, structuredOutput: false, vision: false },
  tier: "fast" as const,
  free: true,
};

function account(provider: string, apiKey: string): string {
  return JSON.stringify({
    provider,
    endpoint: `https://api.${provider}.example/v1/chat/completions`,
    apiKey,
    models: [model],
    rateLimits: { requests: { limit: 7, windowMs: 60_000 } },
  });
}

describe("provider account configuration", () => {
  afterEach(() => vi.restoreAllMocks());

  it("automatically discovers multiple independently scoped accounts for one provider", () => {
    const providers = configuredProviderAccounts({
      BROKEROUTER_PROVIDER_ACCOUNT_GROQ_PRIMARY: account("groq", "primary-secret"),
      BROKEROUTER_PROVIDER_ACCOUNT_GROQ_BACKUP: account("groq", "backup-secret"),
      UNRELATED_VALUE: "ignored",
    }, defaults);

    expect(providers.map(({ id, credentialScope }) => ({ id, credentialScope }))).toEqual([
      { id: "groq", credentialScope: "backup" },
      { id: "groq", credentialScope: "primary" },
    ]);
    expect(providers[0].models[0]).toMatchObject({
      id: "groq@backup/free/default", provider: "groq", credentialScope: "backup",
    });
    expect(providers[1].models[0]).toMatchObject({
      id: "groq@primary/free/default", provider: "groq", credentialScope: "primary",
    });
    expect(providerForModel(providers, providers[0].models[0])?.credentialScope).toBe("backup");
    expect(providerForModel(providers, providers[1].models[0])?.credentialScope).toBe("primary");
    expect(providers[0].rateLimits.requests).toEqual({ limit: 7, windowMs: 60_000 });
  });

  it("does not register the legacy NVIDIA adapter without its legacy key", () => {
    expect(registeredProviders({ NVIDIA_ENABLED: "true" } as Env)).toEqual([]);
  });

  it("keeps tokens out of exposed provider and model metadata and uses the matching token", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("{}"));
    const providers = configuredProviderAccounts({
      BROKEROUTER_PROVIDER_ACCOUNT_GROQ_PRIMARY: account("groq", "primary-secret"),
      BROKEROUTER_PROVIDER_ACCOUNT_GROQ_BACKUP: account("groq", "backup-secret"),
    }, defaults);

    expect(JSON.stringify(providers.map(({ invoke: _invoke, ...provider }) => provider)))
      .not.toContain("secret");
    await providers[0].invoke({ messages: [{ role: "user", content: "hi" }] }, providers[0].models[0]);
    await providers[1].invoke({ messages: [{ role: "user", content: "hi" }] }, providers[1].models[0]);

    expect(fetchMock.mock.calls[0][1]?.headers).toMatchObject({ Authorization: "Bearer backup-secret" });
    expect(fetchMock.mock.calls[1][1]?.headers).toMatchObject({ Authorization: "Bearer primary-secret" });
  });

  it("supports an explicit scope and disabled accounts", () => {
    const configured = JSON.parse(account("gemini", "secret"));
    const providers = configuredProviderAccounts({
      BROKEROUTER_PROVIDER_ACCOUNT_FIRST: JSON.stringify({ ...configured, credentialScope: "team-a" }),
      BROKEROUTER_PROVIDER_ACCOUNT_SECOND: JSON.stringify({ ...configured, enabled: false }),
    }, defaults);
    expect(providers).toHaveLength(1);
    expect(providers[0].credentialScope).toBe("team-a");
  });

  it("fails closed on malformed account configuration", () => {
    expect(() => configuredProviderAccounts({
      BROKEROUTER_PROVIDER_ACCOUNT_BAD: "not-json",
    }, defaults)).toThrow("BROKEROUTER_PROVIDER_ACCOUNT_BAD is not valid JSON");
    expect(() => configuredProviderAccounts({
      BROKEROUTER_PROVIDER_ACCOUNT_BAD: JSON.stringify({ provider: "groq", apiKey: "secret" }),
    }, defaults)).toThrow("BROKEROUTER_PROVIDER_ACCOUNT_BAD is not a valid provider account definition");
    const malformedLimits = JSON.parse(account("groq", "secret"));
    malformedLimits.rateLimits = { requests: { limit: 0, windowMs: 60_000 } };
    expect(() => configuredProviderAccounts({
      BROKEROUTER_PROVIDER_ACCOUNT_BAD: JSON.stringify(malformedLimits),
    }, defaults)).toThrow("BROKEROUTER_PROVIDER_ACCOUNT_BAD is not a valid provider account definition");
  });

  it("preserves credential identity for the legacy provider registry", () => {
    const providers = configuredOpenAiCompatibleProviders(JSON.stringify([{
      id: "groq", endpoint: "https://api.groq.example/v1/chat/completions",
      apiKeyBinding: "GROQ_API_KEY", credentialScope: "secondary", models: [model],
    }]), { GROQ_API_KEY: "secret" }, defaults);
    expect(providers[0].models[0]).toMatchObject({ provider: "groq", credentialScope: "secondary" });
  });
});
