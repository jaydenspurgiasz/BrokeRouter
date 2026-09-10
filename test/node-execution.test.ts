import { describe, expect, it } from "vitest";
import { executeLocalGeneration } from "../src/adapters/node/execution";
import { SqliteState } from "../src/adapters/node/sqlite-state";
import type { ProviderRateLimitSettings } from "../src/core/types";
import type { RegisteredProvider } from "../src/providers/openai-compatible";

const limits: ProviderRateLimitSettings = {
  dailySafetyBudgetTokens: 0,
  cooldownMs: 1_000,
  maxConcurrent: 1,
  reservationTtlMs: 10_000,
};

describe("native stream execution", () => {
  it("closes an upstream stream that becomes inactive without crashing the router", async () => {
    const state = new SqliteState(":memory:");
    const provider: RegisteredProvider = {
      id: "stalled", credentialScope: "primary", rateLimits: limits,
      models: [{
        id: "stalled/model", provider: "stalled", credentialScope: "primary", upstreamModel: "model",
        contextWindow: 8_192, maxOutputTokens: 512,
        supports: { streaming: true, tools: true, structuredOutput: false, vision: false },
        tier: "balanced", free: true,
      }],
      invoke: async () => new Response(new ReadableStream<Uint8Array>({ start() { /* never produces a chunk */ } }), {
        headers: { "content-type": "text/event-stream" },
      }),
    };

    try {
      const response = await executeLocalGeneration(
        { model: "stalled/model", stream: true, max_tokens: 64, messages: [{ role: "user", content: "hello" }] },
        [provider], state, { callerId: "test", environment: "test", rateLimits: limits }, "test-secret",
        { upstreamTimeoutMs: 1_000 },
      );
      await expect(Promise.race([
        response.body!.getReader().read(),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error("stream deadline did not fail the response")), 2_500)),
      ])).rejects.toThrow("Upstream stream inactivity deadline exceeded");
    } finally {
      state.close();
    }
  });
});
