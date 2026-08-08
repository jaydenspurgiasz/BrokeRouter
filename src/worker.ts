import { RouterError, type GenerationRequest, type ProviderRateLimitSettings, type RouteSelection } from "./core/types";
import { NVIDIA_MODELS } from "./core/models";
import { selectRoutes } from "./core/route";
import { invokeNvidia } from "./providers/nvidia";
import { QuotaCoordinator } from "./adapters/cloudflare/quota-coordinator";

export { QuotaCoordinator };

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
  QUOTA_COORDINATOR: DurableObjectNamespace<QuotaCoordinator>;
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    try {
      const url = new URL(request.url);
      if (url.pathname === "/health") return Response.json({ ok: true, service: "broke-router" });
      if (url.pathname === "/v1/models" && request.method === "GET") return Response.json({ object: "list", data: NVIDIA_MODELS });
      if (url.pathname !== "/v1/chat/completions" || request.method !== "POST") {
        return openAiError("invalid_request", "Not found", 404);
      }

      authorize(request, env);
      const generation = await parseGenerationRequest(request);
      const admission = await admitEligibleRoute(selectRoutes(generation), env);
      const { selection, coordinator, reservation, settings } = admission;

      let upstream: Response;
      try {
        upstream = await invokeNvidia(generation, selection.model, env.NVIDIA_API_KEY);
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
        return passthrough(upstream, selection.model.id, "upstream_error");
      }

      ctx.waitUntil(coordinator.recordOutcome(reservation.reservationId!, { success: true, settings }));
      return generation.stream
        ? passthrough(upstream, selection.model.id, "selected")
        : await sanitizeCompletion(upstream, selection.model.id);
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

async function admitEligibleRoute(selections: RouteSelection[], env: Env): Promise<{
  selection: RouteSelection;
  coordinator: DurableObjectStub<QuotaCoordinator>;
  reservation: Awaited<ReturnType<QuotaCoordinator["reserve"]>> & { allowed: true; reservationId: string };
  settings: ProviderRateLimitSettings;
}> {
  const settings = quotaSettings(env);
  const deferred: number[] = [];

  for (const selection of selections) {
    // Provider executors will be registered here as providers are added. Unknown profiles never
    // receive a request just because they exist in a catalog.
    if (selection.model.provider !== "nvidia") continue;
    const coordinator = env.QUOTA_COORDINATOR.getByName(`${selection.model.provider}:default`);
    const reservation = await coordinator.reserve(selection.reservedTokens, settings);
    if (reservation.allowed && reservation.reservationId) {
      return { selection, coordinator, reservation: reservation as typeof reservation & { allowed: true; reservationId: string }, settings };
    }
    if (reservation.retryAfterMs) deferred.push(reservation.retryAfterMs);
  }

  const retryAfterMs = Math.min(...deferred);
  const inlineWait = optionalPositiveNumber(env.MAX_INLINE_WAIT_MS) ?? 0;
  if (Number.isFinite(retryAfterMs) && retryAfterMs > 0 && retryAfterMs <= inlineWait) {
    await sleep(retryAfterMs);
    // One retry only: interactive HTTP remains bounded, while a future job adapter owns durable queues.
    return admitEligibleRouteWithoutWait(selections, env, settings);
  }

  throw new RouterError(
    "provider_unavailable",
    "All eligible free providers are currently rate-limited or cooling down.",
    503,
    Number.isFinite(retryAfterMs) ? retryAfterMs : undefined,
  );
}

async function admitEligibleRouteWithoutWait(
  selections: RouteSelection[], env: Env, settings: ProviderRateLimitSettings,
): Promise<{
  selection: RouteSelection;
  coordinator: DurableObjectStub<QuotaCoordinator>;
  reservation: Awaited<ReturnType<QuotaCoordinator["reserve"]>> & { allowed: true; reservationId: string };
  settings: ProviderRateLimitSettings;
}> {
  const deferred: number[] = [];
  for (const selection of selections) {
    if (selection.model.provider !== "nvidia") continue;
    const coordinator = env.QUOTA_COORDINATOR.getByName(`${selection.model.provider}:default`);
    const reservation = await coordinator.reserve(selection.reservedTokens, settings);
    if (reservation.allowed && reservation.reservationId) {
      return { selection, coordinator, reservation: reservation as typeof reservation & { allowed: true; reservationId: string }, settings };
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

function passthrough(upstream: Response, model: string, reason: string): Response {
  const headers = routedHeaders(upstream.headers, model, reason);
  return new Response(upstream.body, { status: upstream.status, statusText: upstream.statusText, headers });
}

/** Removes provider-specific chain-of-thought fields from non-streaming OpenAI-shaped results. */
async function sanitizeCompletion(upstream: Response, model: string): Promise<Response> {
  const headers = routedHeaders(upstream.headers, model, "selected");
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
    return passthrough(upstream, model, "selected");
  }
}

function routedHeaders(source: Headers, model: string, reason: string): Headers {
  const headers = new Headers(source);
  headers.set("x-broke-router-provider", "nvidia");
  headers.set("x-broke-router-model", model);
  headers.set("x-broke-router-route", reason);
  return headers;
}

function openAiError(code: string, message: string, status: number, retryAfterMs?: number): Response {
  const headers = new Headers({ "content-type": "application/json" });
  if (retryAfterMs) headers.set("retry-after", String(Math.ceil(retryAfterMs / 1_000)));
  return new Response(JSON.stringify({ error: { message, type: code, code } }), { status, headers });
}
