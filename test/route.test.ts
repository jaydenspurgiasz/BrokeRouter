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
});
