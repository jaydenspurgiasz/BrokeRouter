import { afterEach, describe, expect, it, vi } from "vitest";
import { executeGeneration } from "../src/adapters/cloudflare/execution";
import type { Env } from "../src/config";
import type { ProviderRateLimitSettings } from "../src/core/types";

interface RecordedOutcome {
  success: boolean;
  actualTokens?: number;
}

class FakeQuota {
  readonly outcomes: RecordedOutcome[] = [];
  async inspect() {
    return { allowed: true, snapshot: { requestCapacity: 10, tokenCapacity: 100_000, concurrentAvailable: 2 } };
  }
  async reserve() {
    return { allowed: true, reservationId: crypto.randomUUID() };
  }
  async recordOutcome(_reservationId: string, outcome: RecordedOutcome & { settings: ProviderRateLimitSettings }) {
    this.outcomes.push(outcome);
  }
}

class FakeRoutingCoordinator {
  readonly outcomes = new Map<string, RecordedOutcome[]>();

  async planAndReserve(input: {
    candidates: Array<{
      selection: { model: { id: string } };
      providerId: string;
      credentialScope: string;
      catalogOrder: number;
    }>;
    excludedProviderKeys: string[];
  }) {
    const available = input.candidates.filter((candidate) => !input.excludedProviderKeys.includes(
      `${candidate.providerId}:${candidate.credentialScope}`,
    ));
    const selected = available[0];
    if (!selected) return { allowed: false };
    const ranked = available.map((candidate, index) => ({
      selection: candidate.selection,
      providerId: candidate.providerId,
      credentialScope: candidate.credentialScope,
      catalogOrder: candidate.catalogOrder,
      availability: { requestCapacity: 10, tokenCapacity: 100_000, concurrentAvailable: 2 },
      policy: "deterministic-best-fit-v1",
      score: 10_000 - index,
      learnedScore: 10_000 - index,
      posteriorSuccess: 0.5,
      posteriorRateLimitRisk: 0.1,
    }));
    return {
      allowed: true,
      reservation: {
        providerId: selected.providerId,
        credentialScope: selected.credentialScope,
        modelId: selected.selection.model.id,
        reservationId: crypto.randomUUID(),
        reservationRank: 0,
        policy: {
          ranked,
          baselineWinner: `${selected.providerId}:${selected.selection.model.id}`,
          activePolicy: "deterministic-best-fit-v1:cold-start",
          policyVersion: "deterministic-best-fit-v1",
          propensity: 1,
          explored: false,
        },
      },
    };
  }

  async recordProviderOutcome(scope: string, _reservationId: string, outcome: {
    quotaSuccess: boolean; actualTokens?: number;
  }) {
    const values = this.outcomes.get(scope) ?? [];
    values.push({ success: outcome.quotaSuccess, actualTokens: outcome.actualTokens });
    this.outcomes.set(scope, values);
  }
}

afterEach(() => vi.unstubAllGlobals());

describe("multi-provider semantic fallback", () => {
  it("charges but penalizes an empty completion, then returns the next provider's answer", async () => {
    const coordinator = new FakeRoutingCoordinator();
    const callOutcomes: Array<{ providerId: string; success: boolean; status: number; actualTokens?: number }> = [];
    const routingState = {
      async getPlanningState(_query: unknown, defaults: unknown) { return { statistics: [], control: defaults }; },
      async recordDecision() {},
      async recordCallOutcome(outcome: typeof callOutcomes[number]) { callOutcomes.push(outcome); },
    };
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes("nvidia.com")) {
        return Response.json({
          choices: [{ message: { content: null, reasoning_content: "hidden" }, finish_reason: "length" }],
          usage: { total_tokens: 173, completion_tokens: 100 },
        });
      }
      return Response.json({
        choices: [{ message: { role: "assistant", content: "OK", reasoning_content: "private" }, finish_reason: "stop" }],
        usage: { total_tokens: 12, completion_tokens: 2 },
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const env = {
      NVIDIA_API_KEY: "nvidia-key",
      NVIDIA_ENABLED: "true",
      MAX_PROVIDER_ATTEMPTS: "2",
      GEMINI_API_KEY: "gemini-key",
      ADDITIONAL_OPENAI_COMPATIBLE_PROVIDERS_JSON: JSON.stringify([{
        id: "gemini", endpoint: "https://gemini.test/v1/chat/completions", apiKeyBinding: "GEMINI_API_KEY",
        models: [{
          id: "free/default", upstreamModel: "gemini-test", contextWindow: 128_000, maxOutputTokens: 4_096,
          supports: { streaming: true, tools: true, structuredOutput: true, vision: false },
          tier: "balanced", free: true,
        }],
      }]),
      ROUTING_COORDINATOR: { getByName() { return coordinator; } },
      CALLER_QUOTA_COORDINATOR: { getByName() { throw new Error("caller quota should not be used"); } },
      ROUTING_STATE: { getByName() { return routingState; } },
      WORKFLOW_COORDINATOR: { getByName() { throw new Error("workflow should not be used"); } },
    } as unknown as Env;
    const background: Promise<unknown>[] = [];

    const response = await executeGeneration(
      { model: "free/default", messages: [{ role: "user", content: "Reply OK" }], max_tokens: 100 },
      env,
      (promise) => background.push(promise),
      { identity: { callerId: "test", environment: "test" } },
    );
    await Promise.all(background);

    expect(response.status).toBe(200);
    expect(response.headers.get("x-broke-router-provider")).toBe("gemini");
    expect(response.headers.get("x-broke-router-route")).toBe("fallback-selected");
    expect(response.headers.get("x-broke-router-attempts")).toBe("2");
    expect(response.headers.get("x-broke-router-fallback-from")).toBe("nvidia");
    expect(response.headers.get("x-broke-router-provider-timing")).toBe("complete");
    expect(response.headers.get("server-timing")).toMatch(
      /br_provider;dur=[0-9.]+, br_router;dur=[0-9.]+, br_total;dur=[0-9.]+/,
    );
    expect(response.headers.get("server-timing")).toMatch(/br_plan_reserve;dur=[0-9.]+/);
    expect(response.headers.get("server-timing")).toMatch(/br_other;dur=[0-9.]+/);
    const payload = await response.json<Record<string, unknown>>();
    expect(payload).not.toHaveProperty("choices.0.message.reasoning_content");
    expect(payload).toMatchObject({ choices: [{ message: { content: "OK" } }] });
    expect(callOutcomes).toEqual(expect.arrayContaining([
      expect.objectContaining({ providerId: "nvidia", success: false, status: 200, actualTokens: 173 }),
      expect.objectContaining({ providerId: "gemini", success: true, status: 200, actualTokens: 12 }),
    ]));
    expect(coordinator.outcomes.get("nvidia:default")?.[0]).toMatchObject({ success: true, actualTokens: 173 });
    expect(coordinator.outcomes.get("gemini:default")?.[0]).toMatchObject({ success: true, actualTokens: 12 });
  });
});
