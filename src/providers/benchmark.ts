import type { GenerationRequest, ModelProfile } from "../core/types";
import type { RegisteredProvider } from "./openai-compatible";

const MODEL: ModelProfile = {
  id: "benchmark/echo",
  provider: "benchmark",
  credentialScope: "personal-diagnostic",
  upstreamModel: "deterministic-echo-v1",
  contextWindow: 128_000,
  maxOutputTokens: 1_024,
  supports: { streaming: true, tools: false, structuredOutput: true, vision: false },
  tier: "fast",
  free: true,
  automaticRouting: false,
};

const AGENT_MODEL: ModelProfile = {
  id: "benchmark/agent",
  provider: "benchmark",
  credentialScope: "personal-diagnostic",
  upstreamModel: "deterministic-agent-v1",
  contextWindow: 128_000,
  maxOutputTokens: 4_096,
  supports: { streaming: true, tools: true, structuredOutput: true, vision: false },
  tier: "balanced",
  free: true,
};

/** Explicit-only deterministic provider for measuring the deployed server path without LLM quota. */
export function benchmarkProvider(options: { agentic?: boolean } = {}): RegisteredProvider {
  return {
    id: "benchmark",
    credentialScope: "personal-diagnostic",
    models: options.agentic ? [MODEL, AGENT_MODEL] : [MODEL],
    rateLimits: {
      dailySafetyBudgetTokens: 0,
      cooldownMs: 1,
      maxConcurrent: 1_000,
      reservationTtlMs: 10_000,
    },
    invoke: invokeBenchmark,
  };
}

async function invokeBenchmark(request: GenerationRequest, model: ModelProfile): Promise<Response> {
  if (model.id === AGENT_MODEL.id) return invokeAgentBenchmark(request);
  if (request.stream) {
    const encoder = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify({
          id: "benchmark-stream",
          object: "chat.completion.chunk",
          model: MODEL.upstreamModel,
          choices: [{ index: 0, delta: { role: "assistant", content: "BENCHMARK_OK" } }],
        })}\n\n`));
        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
        controller.close();
      },
    });
    return new Response(body, { headers: { "content-type": "text/event-stream", "cache-control": "no-cache" } });
  }
  return Response.json({
    id: "benchmark-completion",
    object: "chat.completion",
    created: Math.floor(Date.now() / 1_000),
    model: MODEL.upstreamModel,
    choices: [{ index: 0, message: { role: "assistant", content: "BENCHMARK_OK" }, finish_reason: "stop" }],
    usage: { prompt_tokens: 8, completion_tokens: 2, total_tokens: 10 },
  });
}

function invokeAgentBenchmark(request: GenerationRequest): Response {
  const toolResult = [...request.messages].reverse().find((message) => message.role === "tool");
  const message = toolResult
    ? { role: "assistant", content: `Agent verified the tool result: ${String(toolResult.content)}` }
    : {
        role: "assistant", content: null,
        tool_calls: [{
          id: "call_weather_1", type: "function",
          function: { name: "get_weather", arguments: JSON.stringify({ city: "Portland" }) },
        }],
      };
  return Response.json({
    id: toolResult ? "benchmark-agent-final" : "benchmark-agent-tool",
    object: "chat.completion",
    created: Math.floor(Date.now() / 1_000),
    model: AGENT_MODEL.upstreamModel,
    choices: [{ index: 0, message, finish_reason: toolResult ? "stop" : "tool_calls" }],
    usage: { prompt_tokens: 12, completion_tokens: 8, total_tokens: 20 },
  });
}
