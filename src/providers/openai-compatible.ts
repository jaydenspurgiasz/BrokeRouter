import type { GenerationRequest, ModelProfile, ProviderRateLimitSettings } from "../core/types";

export interface RegisteredProvider {
  id: string;
  credentialScope: string;
  models: ModelProfile[];
  rateLimits: ProviderRateLimitSettings;
  invoke(request: GenerationRequest, model: ModelProfile): Promise<Response>;
}

export async function invokeOpenAiCompatible(
  endpoint: string, apiKey: string, request: GenerationRequest, model: ModelProfile,
): Promise<Response> {
  const { route: _route, model: _model, ...body } = request;
  return fetch(endpoint, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json", Accept: request.stream ? "text/event-stream" : "application/json" },
    body: JSON.stringify({ ...body, model: model.upstreamModel }),
  });
}

interface ExtraProviderConfig {
  id: string;
  endpoint: string;
  apiKeyBinding: string;
  credentialScope?: string;
  models: Array<Omit<ModelProfile, "provider">>;
  rateLimits?: Partial<ProviderRateLimitSettings>;
}

/** Additional providers are runtime configuration: no provider secret is ever embedded in catalog JSON. */
export function configuredOpenAiCompatibleProviders(
  rawConfig: string | undefined,
  bindings: Record<string, unknown>,
  defaults: ProviderRateLimitSettings,
): RegisteredProvider[] {
  if (!rawConfig) return [];
  let configs: unknown;
  try { configs = JSON.parse(rawConfig); } catch { throw new Error("ADDITIONAL_OPENAI_COMPATIBLE_PROVIDERS_JSON is not valid JSON"); }
  if (!Array.isArray(configs)) throw new Error("ADDITIONAL_OPENAI_COMPATIBLE_PROVIDERS_JSON must be an array");

  return configs.flatMap((candidate): RegisteredProvider[] => {
    if (!isExtraProviderConfig(candidate)) return [];
    const apiKey = bindings[candidate.apiKeyBinding];
    if (typeof apiKey !== "string" || !apiKey) return [];
    const models = candidate.models.map((model) => ({
      ...model,
      // `free/default` remains a routing alias. Every concrete provider model gets a unique
      // explicit ID so callers and integration tests can force a provider deterministically.
      id: model.id === "free/default" ? `${candidate.id}/free/default` : model.id,
      provider: candidate.id,
    }));
    const rateLimits = { ...defaults, ...candidate.rateLimits };
    return [{
      id: candidate.id,
      credentialScope: candidate.credentialScope ?? "default",
      models,
      rateLimits,
      invoke: (request, model) => invokeOpenAiCompatible(candidate.endpoint, apiKey, request, model),
    }];
  });
}

function isExtraProviderConfig(value: unknown): value is ExtraProviderConfig {
  if (!value || typeof value !== "object") return false;
  const config = value as Record<string, unknown>;
  return typeof config.id === "string" && typeof config.endpoint === "string"
    && typeof config.apiKeyBinding === "string" && Array.isArray(config.models);
}
