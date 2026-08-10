import { describe, expect, it } from "vitest";
import { rankCandidates, type AvailableCandidate } from "../src/core/policy";
import type { GenerationRequest, ModelProfile } from "../src/core/types";

const request: GenerationRequest = {
  model: "free/default",
  messages: [{ role: "user", content: "research this" }],
  route: { workflowType: "parallel-research", expectedCalls: 5, maxConcurrency: 3, estimatedTotalTokens: 10_000 },
};

describe("deterministic best-fit policy", () => {
  it("assigns a multi-call workflow to the provider that can fit the whole workload", () => {
    const ranked = rankCandidates(request, [
      candidate("small-free-tier", { requestCapacity: 2, tokenCapacity: 4_000, concurrentAvailable: 1 }),
      candidate("large-free-tier", { requestCapacity: 20, tokenCapacity: 50_000, concurrentAvailable: 5 }),
    ]);
    expect(ranked[0].providerId).toBe("large-free-tier");
    expect(ranked[0].score).toBeGreaterThan(ranked[1].score);
  });

  it("is stable when candidates have identical headroom", () => {
    const availability = { requestCapacity: 10, tokenCapacity: 20_000, concurrentAvailable: 3 };
    const ranked = rankCandidates(request, [candidate("first", availability, 0), candidate("second", availability, 1)]);
    expect(ranked.map((item) => item.providerId)).toEqual(["first", "second"]);
  });

  it("preserves the largest quota by best-fitting a one-call workflow", () => {
    const oneCall: GenerationRequest = {
      messages: [{ role: "user", content: "quick answer" }],
      route: { expectedCalls: 1, maxConcurrency: 1, estimatedTotalTokens: 1_000 },
    };
    const ranked = rankCandidates(oneCall, [
      candidate("small-free-tier", { requestCapacity: 2, tokenCapacity: 2_000, concurrentAvailable: 1 }),
      candidate("large-free-tier", { requestCapacity: 20, tokenCapacity: 50_000, concurrentAvailable: 5 }),
    ]);
    expect(ranked[0].providerId).toBe("small-free-tier");
  });
});

function candidate(
  providerId: string,
  availability: AvailableCandidate["availability"],
  catalogOrder = 0,
): AvailableCandidate {
  const model: ModelProfile = {
    id: `${providerId}/model`, provider: providerId, upstreamModel: "model",
    contextWindow: 128_000, maxOutputTokens: 8_192,
    supports: { streaming: true, tools: true, structuredOutput: true, vision: false },
    tier: "balanced", free: true,
  };
  return {
    providerId, credentialScope: "default", catalogOrder, availability,
    selection: { model, estimatedInputTokens: 100, reservedTokens: 1_100 },
  };
}
