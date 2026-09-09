import type { GenerationRequest, ModelProfile, ProviderRateLimitSettings } from "../core/types";

export interface RegisteredProvider {
  id: string;
  credentialScope: string;
  models: ModelProfile[];
  rateLimits: ProviderRateLimitSettings;
  invoke(request: GenerationRequest, model: ModelProfile, signal?: AbortSignal): Promise<Response>;
}

export async function invokeOpenAiCompatible(
  endpoint: string, apiKey: string, request: GenerationRequest, model: ModelProfile, signal?: AbortSignal,
): Promise<Response> {
  const { route: _route, model: _model, ...body } = request;
  return fetch(endpoint, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json", Accept: request.stream ? "text/event-stream" : "application/json" },
    body: JSON.stringify({ ...body, model: model.upstreamModel }),
    signal,
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

export function providerForModel(
  providers: RegisteredProvider[], model: Pick<ModelProfile, "provider" | "credentialScope">,
): RegisteredProvider | undefined {
  return providers.find((provider) => provider.id === model.provider
    && provider.credentialScope === (model.credentialScope ?? "default"));
}

export const PROVIDER_ACCOUNT_PREFIX = "BROKEROUTER_PROVIDER_ACCOUNT_";

export interface ProviderAccountConfig {
  provider: string;
  endpoint: string;
  apiKey: string;
  credentialScope?: string;
  enabled?: boolean;
  models: Array<Omit<ModelProfile, "provider" | "credentialScope">>;
  rateLimits?: Partial<ProviderRateLimitSettings>;
}

export type ProviderAccountInvokerFactory = (account: Readonly<ProviderAccountConfig>) => RegisteredProvider["invoke"] | undefined;

/** Additional providers are runtime configuration: no provider secret is ever embedded in catalog JSON. */
export function configuredOpenAiCompatibleProviders(
  rawConfig: string | undefined,
  bindings: object,
  defaults: ProviderRateLimitSettings,
): RegisteredProvider[] {
  if (!rawConfig) return [];
  let configs: unknown;
  try { configs = JSON.parse(rawConfig); } catch { throw new Error("ADDITIONAL_OPENAI_COMPATIBLE_PROVIDERS_JSON is not valid JSON"); }
  if (!Array.isArray(configs)) throw new Error("ADDITIONAL_OPENAI_COMPATIBLE_PROVIDERS_JSON must be an array");

  return configs.flatMap((candidate): RegisteredProvider[] => {
    if (!isExtraProviderConfig(candidate)) return [];
    const apiKey = bindingValue(bindings, candidate.apiKeyBinding);
    if (typeof apiKey !== "string" || !apiKey) return [];
    const models = candidate.models.map((model) => ({
      ...model,
      // `free/default` remains a routing alias. Every concrete provider model gets a unique
      // explicit ID so callers and integration tests can force a provider deterministically.
      id: model.id === "free/default" ? `${candidate.id}/free/default` : model.id,
      provider: candidate.id,
      credentialScope: candidate.credentialScope ?? "default",
    }));
    const rateLimits = { ...defaults, ...candidate.rateLimits };
    return [{
      id: candidate.id,
      credentialScope: candidate.credentialScope ?? "default",
      models,
      rateLimits,
        invoke: (request, model, signal) => invokeOpenAiCompatible(candidate.endpoint, apiKey, request, model, signal),
    }];
  });
}

/**
 * Discovers self-contained provider accounts from environment/Worker secret bindings.
 * The API key remains only in the invocation closure and is never added to model metadata.
 */
export function configuredProviderAccounts(
  bindings: object,
  defaults: ProviderRateLimitSettings,
  invokerFactory?: ProviderAccountInvokerFactory,
): RegisteredProvider[] {
  return Object.entries(bindings)
    .filter(([name]) => name.startsWith(PROVIDER_ACCOUNT_PREFIX))
    .sort(([left], [right]) => left.localeCompare(right))
    .flatMap(([bindingName, raw]): RegisteredProvider[] => {
      if (typeof raw !== "string" || !raw.trim()) return [];

      let value: unknown;
      try { value = JSON.parse(raw); } catch {
        throw new Error(`${bindingName} is not valid JSON`);
      }
      if (!isProviderAccountConfig(value)) {
        throw new Error(`${bindingName} is not a valid provider account definition`);
      }
      if (value.enabled === false) return [];

      const bindingScope = bindingName.slice(PROVIDER_ACCOUNT_PREFIX.length)
        .toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
      const providerPrefix = `${value.provider.toLowerCase().replace(/[^a-z0-9]+/g, "-")}-`;
      const derivedScope = bindingScope.startsWith(providerPrefix)
        ? bindingScope.slice(providerPrefix.length) : bindingScope;
      const credentialScope = value.credentialScope?.trim() || derivedScope;
      if (!credentialScope) throw new Error(`${bindingName} must identify an account`);

      const models = value.models.map((model) => ({
        ...model,
        id: accountModelId(value.provider, credentialScope, model.id),
        provider: value.provider,
        credentialScope,
      }));
      const rateLimits = { ...defaults, ...value.rateLimits };
      return [{
        id: value.provider,
        credentialScope,
        models,
        rateLimits,
        invoke: invokerFactory?.(value)
          ?? ((request, model, signal) => invokeOpenAiCompatible(value.endpoint, value.apiKey, request, model, signal)),
      }];
    });
}

function isExtraProviderConfig(value: unknown): value is ExtraProviderConfig {
  if (!value || typeof value !== "object") return false;
  const config = value as Record<string, unknown>;
  return typeof config.id === "string" && typeof config.endpoint === "string"
    && typeof config.apiKeyBinding === "string" && Array.isArray(config.models);
}

function bindingValue(bindings: object, name: string): unknown {
  return Object.entries(bindings).find(([bindingName]) => bindingName === name)?.[1];
}

function isProviderAccountConfig(value: unknown): value is ProviderAccountConfig {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const config = value as Record<string, unknown>;
  return typeof config.provider === "string" && /^[a-z0-9][a-z0-9._-]*$/i.test(config.provider)
    && typeof config.endpoint === "string" && isSafeEndpoint(config.endpoint)
    && typeof config.apiKey === "string" && config.apiKey.length > 0
    && (config.credentialScope === undefined
      || (typeof config.credentialScope === "string" && /^[a-z0-9][a-z0-9._-]*$/i.test(config.credentialScope)))
    && (config.enabled === undefined || typeof config.enabled === "boolean")
    && Array.isArray(config.models) && config.models.length > 0
    && config.models.every(isConfiguredModel)
    && isRateLimits(config.rateLimits);
}

function isSafeEndpoint(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:" || (url.protocol === "http:"
      && (url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]"));
  } catch {
    return false;
  }
}

function isConfiguredModel(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const model = value as Record<string, unknown>;
  const supports = model.supports as Record<string, unknown> | undefined;
  return typeof model.id === "string" && model.id.trim().length > 0
    && typeof model.upstreamModel === "string" && model.upstreamModel.trim().length > 0
    && positiveFinite(model.contextWindow)
    && positiveFinite(model.maxOutputTokens)
    && (model.tier === "fast" || model.tier === "balanced" || model.tier === "reasoning")
    && typeof model.free === "boolean" && !!supports
    && typeof supports.streaming === "boolean" && typeof supports.tools === "boolean"
    && typeof supports.structuredOutput === "boolean" && typeof supports.vision === "boolean";
}

function isRateLimits(value: unknown): boolean {
  if (value === undefined) return true;
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const limits = value as Record<string, unknown>;
  return optionalNumber(limits.dailySafetyBudgetTokens, true)
    && optionalNumber(limits.cooldownMs)
    && optionalWindow(limits.requests)
    && optionalWindow(limits.tokens)
    && optionalNumber(limits.maxConcurrent)
    && optionalNumber(limits.reservationTtlMs);
}

function optionalWindow(value: unknown): boolean {
  if (value === undefined) return true;
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const window = value as Record<string, unknown>;
  return positiveFinite(window.limit) && positiveFinite(window.windowMs);
}

function optionalNumber(value: unknown, allowZero = false): boolean {
  return value === undefined || (allowZero
    ? typeof value === "number" && Number.isFinite(value) && value >= 0
    : positiveFinite(value));
}

function positiveFinite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function accountModelId(provider: string, scope: string, modelId: string): string {
  const unscoped = modelId.startsWith(`${provider}/`) ? modelId.slice(provider.length + 1) : modelId;
  return `${provider}@${scope}/${unscoped}`;
}
