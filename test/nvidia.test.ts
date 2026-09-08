import { afterEach, describe, expect, it, vi } from "vitest";
import { invokeNvidia } from "../src/providers/nvidia";
import type { GenerationRequest, ModelProfile } from "../src/core/types";

const request: GenerationRequest = { messages: [{ role: "user", content: "Hello" }] };
const gptOss: ModelProfile = {
  id: "free/default", provider: "nvidia", upstreamModel: "openai/gpt-oss-20b",
  contextWindow: 128_000, maxOutputTokens: 4_096,
  supports: { streaming: true, tools: true, structuredOutput: false, vision: false },
  tier: "balanced", free: true,
};

afterEach(() => vi.unstubAllGlobals());

describe("NVIDIA adapter reasoning controls", () => {
  it("uses GPT-OSS's documented minimum reasoning effort by default", async () => {
    const fetchMock = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) => Response.json({ ok: true }));
    vi.stubGlobal("fetch", fetchMock);
    await invokeNvidia({
      ...request,
      reasoning_effort: "high",
      chat_template_kwargs: { enable_thinking: true },
    }, gptOss, "secret");
    const init = fetchMock.mock.calls[0][1] as RequestInit;
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    expect(body.reasoning_effort).toBe("low");
    expect(body.chat_template_kwargs).toBeUndefined();
  });

  it("uses high reasoning effort only when the trusted route requests it", async () => {
    const fetchMock = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) => Response.json({ ok: true }));
    vi.stubGlobal("fetch", fetchMock);
    await invokeNvidia({ ...request, route: { reasoning: "on" } }, gptOss, "secret");
    const init = fetchMock.mock.calls[0][1] as RequestInit;
    expect(JSON.parse(String(init.body))).toMatchObject({ reasoning_effort: "high" });
  });
});
