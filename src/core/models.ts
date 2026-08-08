import type { ModelProfile } from "./types";

/**
 * Provider capability information is configuration, not a provider assumption.
 * Update this registry as NVIDIA's catalog changes; do not silently accept unknown models.
 */
export const NVIDIA_MODELS: ModelProfile[] = [
  {
    id: "free/default",
    provider: "nvidia",
    upstreamModel: "openai/gpt-oss-20b",
    contextWindow: 128_000,
    maxOutputTokens: 16_384,
    supports: { streaming: true, tools: true, structuredOutput: false, vision: false },
    tier: "balanced",
    free: true,
  },
  {
    id: "nvidia/openai/gpt-oss-20b",
    provider: "nvidia",
    upstreamModel: "openai/gpt-oss-20b",
    contextWindow: 128_000,
    maxOutputTokens: 16_384,
    supports: { streaming: true, tools: true, structuredOutput: false, vision: false },
    tier: "balanced",
    free: true,
  },
  {
    id: "vision/default",
    provider: "nvidia",
    upstreamModel: "meta/llama-4-maverick-17b-128e-instruct",
    contextWindow: 1_000_000,
    maxOutputTokens: 8_192,
    supports: { streaming: true, tools: true, structuredOutput: false, vision: true },
    tier: "reasoning",
    free: true,
  },
];
