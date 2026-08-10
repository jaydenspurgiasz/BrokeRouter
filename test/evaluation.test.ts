import { describe, expect, it } from "vitest";
import { evaluateOffPolicy, simulateWorkloads, type SimulatedProvider } from "../src/core/evaluation";
import type { ModelProfile } from "../src/core/types";

describe("policy evaluation", () => {
  it("computes IPS, SNIPS, and effective sample size", () => {
    const result = evaluateOffPolicy([
      { reward: 1, loggedPropensity: 0.5, targetPropensity: 1 },
      { reward: 0, loggedPropensity: 0.5, targetPropensity: 0.5 },
    ]);
    expect(result.inversePropensityScore).toBe(1);
    expect(result.selfNormalizedScore).toBeCloseTo(2 / 3);
    expect(result.effectiveSampleSize).toBeGreaterThan(1);
  });

  it("best-fits small work while preserving the large provider for a later workflow", () => {
    const result = simulateWorkloads([
      { id: "small", expectedCalls: 1, maxConcurrency: 1, estimatedTokens: 1_000, priority: 100 },
      { id: "large", expectedCalls: 5, maxConcurrency: 3, estimatedTokens: 10_000, priority: 50 },
    ], [
      provider("small-tier", 2, 2_000, 1), provider("large-tier", 10, 20_000, 4),
    ]);
    expect(result.completed).toBe(2);
    expect(result.allocations).toEqual({ "small-tier": 1, "large-tier": 1 });
  });
});

function provider(id: string, requests: number, tokens: number, concurrency: number): SimulatedProvider {
  const model: ModelProfile = {
    id: `${id}/model`, provider: id, upstreamModel: "model", contextWindow: 128_000,
    maxOutputTokens: 4_096, supports: { streaming: true, tools: true, structuredOutput: false, vision: false },
    tier: "balanced", free: true,
  };
  return {
    providerId: id, credentialScope: "default", catalogOrder: id === "small-tier" ? 0 : 1,
    availability: { requestCapacity: requests, tokenCapacity: tokens, concurrentAvailable: concurrency },
    selection: { model, estimatedInputTokens: 100, reservedTokens: 1_124 }, successProbability: 0.95,
  };
}
