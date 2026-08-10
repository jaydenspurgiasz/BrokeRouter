import type { Env } from "../../config";
import { NVIDIA_MODELS } from "../../core/models";
import type { ProviderRateLimitSettings } from "../../core/types";
import { configuredOpenAiCompatibleProviders, type RegisteredProvider } from "../../providers/openai-compatible";
import { invokeNvidia } from "../../providers/nvidia";

export function registeredProviders(env: Env): RegisteredProvider[] {
  const nvidiaLimits = quotaSettings(env);
  const nvidia: RegisteredProvider = {
    id: "nvidia",
    credentialScope: "default",
    models: NVIDIA_MODELS,
    rateLimits: nvidiaLimits,
    invoke: (request, model) => invokeNvidia(request, model, env.NVIDIA_API_KEY),
  };
  const builtIns = env.NVIDIA_ENABLED === "false" ? [] : [nvidia];
  return [...builtIns, ...configuredOpenAiCompatibleProviders(
    env.ADDITIONAL_OPENAI_COMPATIBLE_PROVIDERS_JSON,
    env as unknown as Record<string, unknown>,
    nvidiaLimits,
  )];
}

export function quotaSettings(env: Env): ProviderRateLimitSettings {
  return {
    dailySafetyBudgetTokens: Number(env.NVIDIA_DAILY_SAFETY_BUDGET_TOKENS ?? "0"),
    cooldownMs: positiveNumber(env.NVIDIA_COOLDOWN_MS, 900_000),
    requests: optionalWindow(env.NVIDIA_REQUESTS_PER_WINDOW, env.NVIDIA_REQUEST_WINDOW_MS),
    tokens: optionalWindow(env.NVIDIA_TOKENS_PER_WINDOW, env.NVIDIA_TOKEN_WINDOW_MS),
    maxConcurrent: optionalPositiveNumber(env.NVIDIA_MAX_CONCURRENT),
    reservationTtlMs: positiveNumber(env.NVIDIA_RESERVATION_TTL_MS, 120_000),
  };
}

export function optionalPositiveNumber(value: string | undefined): number | undefined {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : undefined;
}

function positiveNumber(value: string | undefined, fallback: number): number {
  return optionalPositiveNumber(value) ?? fallback;
}

function optionalWindow(limitValue: string | undefined, windowValue: string | undefined): ProviderRateLimitSettings["requests"] {
  const limit = optionalPositiveNumber(limitValue);
  const windowMs = optionalPositiveNumber(windowValue);
  return limit && windowMs ? { limit, windowMs } : undefined;
}
