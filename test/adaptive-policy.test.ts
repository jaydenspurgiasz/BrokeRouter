import { describe, expect, it } from "vitest";
import { decidePolicy, type ProviderStatistics } from "../src/core/adaptive-policy";
import type { AvailableCandidate } from "../src/core/policy";
import type { GenerationRequest, ModelProfile } from "../src/core/types";

const request: GenerationRequest = { messages: [{ role: "user", content: "route me" }] };

describe("adaptive policy", () => {
  it("computes a shadow winner without changing the baseline route", () => {
    const candidates = [candidate("baseline", 0), candidate("learned", 1)];
    const decision = decidePolicy(request, candidates, [
      stats("baseline", 0.2), stats("learned", 0.95),
    ], { mode: "shadow", explorationRate: 0.05, minObservations: 10 });
    expect(decision.ranked[0].providerId).toBe("baseline");
    expect(decision.shadowWinner).toContain("learned");
  });

  it("activates bounded exploration with an exact logged propensity", () => {
    const randomValues = [0, 0.99];
    const decision = decidePolicy(request, [candidate("a", 0), candidate("b", 1)], [
      stats("a", 0.9), stats("b", 0.8),
    ], { mode: "adaptive", explorationRate: 0.1, minObservations: 10, random: () => randomValues.shift() ?? 0 });
    expect(decision.explored).toBe(true);
    expect(decision.ranked[0].providerId).toBe("b");
    expect(decision.propensity).toBeCloseTo(0.05);
  });

  it("stays on the baseline during cold start", () => {
    const decision = decidePolicy(request, [candidate("a", 0), candidate("b", 1)], [], {
      mode: "adaptive", explorationRate: 0.1, minObservations: 30,
    });
    expect(decision.ranked[0].providerId).toBe("a");
    expect(decision.activePolicy).toContain("cold-start");
  });
});

function candidate(providerId: string, catalogOrder: number): AvailableCandidate {
  const model: ModelProfile = {
    id: `${providerId}/model`, provider: providerId, upstreamModel: "model",
    contextWindow: 128_000, maxOutputTokens: 4_096,
    supports: { streaming: true, tools: true, structuredOutput: false, vision: false },
    tier: "balanced", free: true,
  };
  return {
    providerId, credentialScope: "default", catalogOrder,
    availability: { requestCapacity: 10, tokenCapacity: 50_000, concurrentAvailable: 5 },
    selection: { model, estimatedInputTokens: 100, reservedTokens: 1_124 },
  };
}

function stats(providerId: string, success: number): ProviderStatistics {
  return {
    providerId, modelId: `${providerId}/model`, observations: 100,
    successAlpha: success * 100, successBeta: (1 - success) * 100,
    completionAlpha: success * 100, completionBeta: (1 - success) * 100,
    rateLimitAlpha: 1, rateLimitBeta: 99, qualityMean: 0.5, qualityCount: 0, latencyEwmaMs: 100,
  };
}
