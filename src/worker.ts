import { RouterError, type GenerationRequest, type ProviderRateLimitSettings, type RouteSelection } from "./core/types";
import { NVIDIA_MODELS } from "./core/models";
import { selectRoutes } from "./core/route";
import { invokeNvidia } from "./providers/nvidia";
import { configuredOpenAiCompatibleProviders, type RegisteredProvider } from "./providers/openai-compatible";
import { QuotaCoordinator } from "./adapters/cloudflare/quota-coordinator";
import { AsyncJobQueue } from "./adapters/cloudflare/async-job-queue";

export { QuotaCoordinator, AsyncJobQueue };

export interface Env {
  NVIDIA_API_KEY: string;
  ROUTER_API_KEY?: string;
  NVIDIA_DAILY_SAFETY_BUDGET_TOKENS?: string;
  NVIDIA_COOLDOWN_MS?: string;
  NVIDIA_REQUESTS_PER_WINDOW?: string;
  NVIDIA_REQUEST_WINDOW_MS?: string;
  NVIDIA_TOKENS_PER_WINDOW?: string;
  NVIDIA_TOKEN_WINDOW_MS?: string;
  NVIDIA_MAX_CONCURRENT?: string;
  NVIDIA_RESERVATION_TTL_MS?: string;
  MAX_INLINE_WAIT_MS?: string;
  ASYNC_JOB_MAX_ATTEMPTS?: string;
  ASYNC_JOB_RETENTION_MS?: string;
  ADDITIONAL_OPENAI_COMPATIBLE_PROVIDERS_JSON?: string;
  QUOTA_COORDINATOR: DurableObjectNamespace<QuotaCoordinator>;
  ASYNC_JOB_QUEUE: DurableObjectNamespace<AsyncJobQueue>;
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    try {
      const url = new URL(request.url);
      if (url.pathname === "/health") return Response.json({ ok: true, service: "broke-router" });
      if (url.pathname === "/v1/models" && request.method === "GET") {
        return Response.json({ object: "list", data: registeredProviders(env).flatMap((provider) => provider.models) });
      }
      if (url.pathname === "/v1/jobs" && request.method === "POST") {
        authorize(request, env);
        const generation = await parseGenerationRequest(request);
        const job = await env.ASYNC_JOB_QUEUE.getByName("default").fetch("https://queue/enqueue", {
          method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(generation),
        }).then((response) => response.json<{ id: string; status: string; createdAt: number; updatedAt: number }>());
        return Response.json({ ...job, status_url: `/v1/jobs/${job.id}` }, { status: 202 });
      }
      if (url.pathname.startsWith("/v1/jobs/") && request.method === "GET") {
        authorize(request, env);
        const response = await env.ASYNC_JOB_QUEUE.getByName("default").fetch(`https://queue/jobs/${url.pathname.slice("/v1/jobs/".length)}`);
        return response.status === 404 ? openAiError("invalid_request", "Job not found", 404) : response;
      }
      if (url.pathname !== "/v1/chat/completions" || request.method !== "POST") {
        return openAiError("invalid_request", "Not found", 404);
      }

      authorize(request, env);
      const generation = await parseGenerationRequest(request);
      const providers = registeredProviders(env);
      const admission = await admitEligibleRoute(selectRoutes(generation, providers.flatMap((provider) => provider.models)), providers, env);
      const { selection, provider, coordinator, reservation, settings } = admission;

      let upstream: Response;
      try {
        upstream = await provider.invoke(generation, selection.model);
      } catch {
        ctx.waitUntil(coordinator.recordOutcome(reservation.reservationId!, { success: false, cooldown: true, settings }));
        throw new RouterError("upstream_error", "NVIDIA could not be reached.", 502);
      }

      if (!upstream.ok) {
        const retryAfterMs = retryAfter(upstream);
        ctx.waitUntil(coordinator.recordOutcome(reservation.reservationId!, {
          success: false,
          cooldown: upstream.status === 429 || upstream.status >= 500,
          observation: { status: upstream.status, retryAfterMs },
          settings,
        }));
        return passthrough(upstream, provider.id, selection.model.id, "upstream_error");
      }

      ctx.waitUntil(coordinator.recordOutcome(reservation.reservationId!, { success: true, settings }));
      return generation.stream
        ? passthrough(upstream, provider.id, selection.model.id, "selected")
        : await sanitizeCompletion(upstream, provider.id, selection.model.id);
    } catch (error) {
      if (error instanceof RouterError) return openAiError(error.code, error.message, error.status, error.retryAfterMs);
      console.error("Unhandled router error", error);
      return openAiError("upstream_error", "Router failed while processing the request.", 500);
    }
  },
} satisfies ExportedHandler<Env>;

function authorize(request: Request, env: Env): void {
  if (!env.ROUTER_API_KEY) return;
  if (request.headers.get("authorization") !== `Bearer ${env.ROUTER_API_KEY}`) {
    throw new RouterError("authentication_error", "Invalid router API key.", 401);
  }
}

async function parseGenerationRequest(request: Request): Promise<GenerationRequest> {
  try {
    return await request.json<GenerationRequest>();
  } catch {
    throw new RouterError("invalid_request", "Request body must be valid JSON.", 400);
  }
}

function quotaSettings(env: Env): ProviderRateLimitSettings {
  return {
    dailySafetyBudgetTokens: Number(env.NVIDIA_DAILY_SAFETY_BUDGET_TOKENS ?? "0"),
    cooldownMs: Number(env.NVIDIA_COOLDOWN_MS ?? "900000"),
    requests: optionalWindow(env.NVIDIA_REQUESTS_PER_WINDOW, env.NVIDIA_REQUEST_WINDOW_MS),
    tokens: optionalWindow(env.NVIDIA_TOKENS_PER_WINDOW, env.NVIDIA_TOKEN_WINDOW_MS),
    maxConcurrent: optionalPositiveNumber(env.NVIDIA_MAX_CONCURRENT),
    reservationTtlMs: positiveNumber(env.NVIDIA_RESERVATION_TTL_MS, 120_000),
  };
}

async function admitEligibleRoute(selections: RouteSelection[], providers: RegisteredProvider[], env: Env): Promise<{
  selection: RouteSelection;
  provider: RegisteredProvider;
  coordinator: DurableObjectStub<QuotaCoordinator>;
  reservation: Awaited<ReturnType<QuotaCoordinator["reserve"]>> & { allowed: true; reservationId: string };
  settings: ProviderRateLimitSettings;
}> {
  const deferred: number[] = [];

  for (const selection of selections) {
    const provider = providers.find((item) => item.id === selection.model.provider);
    if (!provider) continue;
    const settings = provider.rateLimits;
    const coordinator = env.QUOTA_COORDINATOR.getByName(`${provider.id}:${provider.credentialScope}`);
    const reservation = await coordinator.reserve(selection.reservedTokens, settings);
    if (reservation.allowed && reservation.reservationId) {
      return { selection, provider, coordinator, reservation: reservation as typeof reservation & { allowed: true; reservationId: string }, settings };
    }
    if (reservation.retryAfterMs) deferred.push(reservation.retryAfterMs);
  }

  const retryAfterMs = Math.min(...deferred);
  const inlineWait = optionalPositiveNumber(env.MAX_INLINE_WAIT_MS) ?? 0;
  if (Number.isFinite(retryAfterMs) && retryAfterMs > 0 && retryAfterMs <= inlineWait) {
    await sleep(retryAfterMs);
    // One retry only: interactive HTTP remains bounded, while a future job adapter owns durable queues.
    return admitEligibleRouteWithoutWait(selections, providers, env);
  }

  throw new RouterError(
    "provider_unavailable",
    "All eligible free providers are currently rate-limited or cooling down.",
    503,
    Number.isFinite(retryAfterMs) ? retryAfterMs : undefined,
  );
}

async function admitEligibleRouteWithoutWait(
  selections: RouteSelection[], providers: RegisteredProvider[], env: Env,
): Promise<{
  selection: RouteSelection;
  provider: RegisteredProvider;
  coordinator: DurableObjectStub<QuotaCoordinator>;
  reservation: Awaited<ReturnType<QuotaCoordinator["reserve"]>> & { allowed: true; reservationId: string };
  settings: ProviderRateLimitSettings;
}> {
  const deferred: number[] = [];
  for (const selection of selections) {
    const provider = providers.find((item) => item.id === selection.model.provider);
    if (!provider) continue;
    const settings = provider.rateLimits;
    const coordinator = env.QUOTA_COORDINATOR.getByName(`${provider.id}:${provider.credentialScope}`);
    const reservation = await coordinator.reserve(selection.reservedTokens, settings);
    if (reservation.allowed && reservation.reservationId) {
      return { selection, provider, coordinator, reservation: reservation as typeof reservation & { allowed: true; reservationId: string }, settings };
    }
    if (reservation.retryAfterMs) deferred.push(reservation.retryAfterMs);
  }
  const retryAfterMs = Math.min(...deferred);
  throw new RouterError("provider_unavailable", "All eligible free providers are still unavailable.", 503,
    Number.isFinite(retryAfterMs) ? retryAfterMs : undefined);
}

function optionalWindow(limitValue: string | undefined, windowValue: string | undefined): ProviderRateLimitSettings["requests"] {
  const limit = optionalPositiveNumber(limitValue);
  const windowMs = optionalPositiveNumber(windowValue);
  return limit && windowMs ? { limit, windowMs } : undefined;
}

function optionalPositiveNumber(value: string | undefined): number | undefined {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : undefined;
}

function positiveNumber(value: string | undefined, fallback: number): number {
  return optionalPositiveNumber(value) ?? fallback;
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function retryAfter(response: Response): number | undefined {
  const value = response.headers.get("retry-after");
  const standard = parseRetryDelay(value);
  if (standard !== undefined) return standard;

  // Common provider variants. These are only used when an upstream refusal occurs;
  // a provider-specific adapter can later add richer observations without changing policy.
  for (const name of ["x-ratelimit-reset", "x-ratelimit-reset-requests", "x-ratelimit-reset-tokens"]) {
    const parsed = parseRetryDelay(response.headers.get(name));
    if (parsed !== undefined) return parsed;
  }
  return undefined;
}

function parseRetryDelay(value: string | null): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1_000;
  const date = Date.parse(value);
  return Number.isFinite(date) && date > Date.now() ? date - Date.now() : undefined;
}

function passthrough(upstream: Response, provider: string, model: string, reason: string): Response {
  const headers = routedHeaders(upstream.headers, provider, model, reason);
  return new Response(upstream.body, { status: upstream.status, statusText: upstream.statusText, headers });
}

/** Removes provider-specific chain-of-thought fields from non-streaming OpenAI-shaped results. */
async function sanitizeCompletion(upstream: Response, provider: string, model: string): Promise<Response> {
  const headers = routedHeaders(upstream.headers, provider, model, "selected");
  try {
    const payload = await upstream.clone().json<Record<string, unknown>>();
    const choices = payload.choices;
    if (Array.isArray(choices)) {
      for (const choice of choices) {
        if (!choice || typeof choice !== "object") continue;
        const message = (choice as Record<string, unknown>).message;
        if (message && typeof message === "object") {
          delete (message as Record<string, unknown>).reasoning;
          delete (message as Record<string, unknown>).reasoning_content;
        }
      }
    }
    headers.set("content-type", "application/json");
    headers.delete("content-length");
    headers.delete("content-encoding");
    return new Response(JSON.stringify(payload), { status: upstream.status, statusText: upstream.statusText, headers });
  } catch {
    return passthrough(upstream, provider, model, "selected");
  }
}

function routedHeaders(source: Headers, provider: string, model: string, reason: string): Headers {
  const headers = new Headers(source);
  headers.set("x-broke-router-provider", provider);
  headers.set("x-broke-router-model", model);
  headers.set("x-broke-router-route", reason);
  return headers;
}

function registeredProviders(env: Env): RegisteredProvider[] {
  const nvidiaLimits = quotaSettings(env);
  const nvidia: RegisteredProvider = {
    id: "nvidia",
    credentialScope: "default",
    models: NVIDIA_MODELS,
    rateLimits: nvidiaLimits,
    invoke: (request, model) => invokeNvidia(request, model, env.NVIDIA_API_KEY),
  };
  const extras = configuredOpenAiCompatibleProviders(
    env.ADDITIONAL_OPENAI_COMPATIBLE_PROVIDERS_JSON,
    env as unknown as Record<string, unknown>,
    nvidiaLimits,
  );
  return [nvidia, ...extras];
}

function openAiError(code: string, message: string, status: number, retryAfterMs?: number): Response {
  const headers = new Headers({ "content-type": "application/json" });
  if (retryAfterMs) headers.set("retry-after", String(Math.ceil(retryAfterMs / 1_000)));
  return new Response(JSON.stringify({ error: { message, type: code, code } }), { status, headers });
}
