import { describe, expect, it } from "vitest";
import { selectRoute, selectRoutes } from "../src/core/route";
import { RouterError, type GenerationRequest, type ModelProfile } from "../src/core/types";

const baseRequest: GenerationRequest = {
  messages: [{ role: "user", content: "Explain durable state in one sentence." }],
};

describe("selectRoute", () => {
  it("chooses the free default NVIDIA model", () => {
    const route = selectRoute(baseRequest);
    expect(route.model.id).toBe("free/default");
    expect(route.reservedTokens).toBeGreaterThan(1_024);
  });

  it("selects a vision-capable model when image content is present", () => {
    const route = selectRoute({
      ...baseRequest,
      model: "vision/default",
      messages: [{ role: "user", content: [{ type: "image_url", image_url: { url: "https://example.com/a.png" } }] }],
    });
    expect(route.model.supports.vision).toBe(true);
  });

  it("accepts assistant tool-call messages without content", () => {
    expect(() => selectRoute({
      ...baseRequest,
      messages: [
        { role: "user", content: "Look this up." },
        { role: "assistant", content: undefined, tool_calls: [{ id: "call_1", type: "function" }] },
        { role: "tool", content: "found", tool_call_id: "call_1" },
      ],
    })).not.toThrow();
  });

  it("rejects malformed messages instead of throwing an internal type error", () => {
    expect(() => selectRoute({ ...baseRequest, messages: [null as never] })).toThrow(RouterError);
  });

  it("refuses a request that cannot fit without truncation", () => {
    expect(() => selectRoute({ ...baseRequest, max_tokens: 999_999 })).toThrow(RouterError);
  });

  it("rejects an unsupported model instead of forwarding arbitrary model IDs", () => {
    expect(() => selectRoute({ ...baseRequest, model: "some/unknown-model" })).toThrow(RouterError);
  });

  it("keeps every eligible candidate available for runtime admission control", () => {
    const routes = selectRoutes({ ...baseRequest, model: "free/default" });
    expect(routes.length).toBeGreaterThan(1);
    expect(routes[0].model.id).toBe("free/default");
    expect(routes[0].reservedTokens).toBeGreaterThan(routes[0].estimatedInputTokens);
  });

  it("excludes explicit-only diagnostic models from automatic routing", () => {
    const diagnostic: ModelProfile = {
      id: "benchmark/echo", provider: "benchmark", upstreamModel: "echo",
      contextWindow: 128_000, maxOutputTokens: 1_024,
      supports: { streaming: true, tools: false, structuredOutput: true, vision: false },
      tier: "fast", free: true, automaticRouting: false,
    };
    expect(selectRoutes(baseRequest, [diagnostic, ...selectRoutes(baseRequest).map((route) => route.model)]))
      .not.toEqual(expect.arrayContaining([expect.objectContaining({ model: diagnostic })]));
    expect(selectRoute({ ...baseRequest, model: "benchmark/echo" }, [diagnostic]).model.id)
      .toBe("benchmark/echo");
  });

  it("enforces the free/hermes virtual model contract", () => {
    const capable: ModelProfile = {
      id: "provider-a/model", provider: "provider-a", upstreamModel: "model",
      contextWindow: 128_000, maxOutputTokens: 8_192,
      supports: { streaming: true, tools: true, structuredOutput: false, vision: false },
      tier: "balanced", free: true,
    };
    const noTools = { ...capable, id: "provider-b/model", provider: "provider-b", supports: { ...capable.supports, tools: false } };
    const tooSmall = { ...capable, id: "provider-c/model", provider: "provider-c", contextWindow: 32_000 };
    const paid = { ...capable, id: "provider-d/model", provider: "provider-d", free: false };
    const routes = selectRoutes({ ...baseRequest, model: "free/hermes", route: { allowPaid: true } }, [
      noTools, tooSmall, paid, capable,
    ]);
    expect(routes.map((route) => route.model.id)).toEqual([capable.id]);
  });

  it("validates bounded session affinity keys", () => {
    expect(() => selectRoute({ ...baseRequest, route: { affinityKey: "" } })).toThrow(RouterError);
    expect(() => selectRoute({ ...baseRequest, route: { affinityKey: "x".repeat(257) } })).toThrow(RouterError);
    expect(() => selectRoute({ ...baseRequest, route: { affinityKey: "hermes-conversation-1" } })).not.toThrow();
  });

  it("keeps the compression tier non-streaming and tool-free", () => {
    expect(() => selectRoute({ ...baseRequest, model: "free/compression", stream: true })).toThrow(RouterError);
    expect(() => selectRoute({ ...baseRequest, model: "free/compression", tools: [{ type: "function", function: { name: "x" } }] }))
      .toThrow(RouterError);
  });
});
