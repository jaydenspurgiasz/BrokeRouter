import type { GenerationRequest, ModelProfile } from "../core/types";
import type { RegisteredProvider } from "./openai-compatible";

const MODEL: ModelProfile = {
  id: "benchmark/echo",
  provider: "benchmark",
  upstreamModel: "deterministic-echo-v1",
  contextWindow: 128_000,
  maxOutputTokens: 1_024,
  supports: { streaming: true, tools: false, structuredOutput: true, vision: false },
  tier: "fast",
  free: true,
  automaticRouting: false,
};

/** Staging-only deterministic provider for measuring the deployed server path without LLM quota. */
export function benchmarkProvider(): RegisteredProvider {
  return {
    id: "benchmark",
    credentialScope: "staging-diagnostic",
    models: [MODEL],
    rateLimits: {
      dailySafetyBudgetTokens: 0,
      cooldownMs: 1,
      maxConcurrent: 1_000,
      reservationTtlMs: 10_000,
    },
    invoke: invokeBenchmark,
  };
}

async function invokeBenchmark(request: GenerationRequest): Promise<Response> {
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
