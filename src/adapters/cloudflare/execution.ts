import type { Env } from "../../config";
import { rankCandidates, type AvailableCandidate } from "../../core/policy";
import { selectRoutes } from "../../core/route";
import { RouterError, type GenerationRequest, type ProviderRateLimitSettings, type RouteSelection } from "../../core/types";
import type { RegisteredProvider } from "../../providers/openai-compatible";
import type { AdmissionQuote, QuotaCoordinator, ReservationResult } from "./quota-coordinator";
import { optionalPositiveNumber, registeredProviders } from "./provider-registry";

type WaitUntil = (promise: Promise<unknown>) => void;

interface CandidateRuntime {
  selection: RouteSelection;
  provider: RegisteredProvider;
  coordinator: DurableObjectStub<QuotaCoordinator>;
  quote: AdmissionQuote;
  catalogOrder: number;
}

interface ReservedRuntime extends CandidateRuntime {
  reservation: ReservationResult & { allowed: true; reservationId: string };
}

/** Shared multi-provider execution path for interactive calls and durable jobs. */
export async function executeGeneration(
  generation: GenerationRequest,
  env: Env,
  waitUntil: WaitUntil,
  options: { allowInlineWait?: boolean } = {},
): Promise<Response> {
  const providers = registeredProviders(env);
  const selections = selectRoutes(generation, providers.flatMap((provider) => provider.models));
  const admission = await admitRankedRoute(generation, selections, providers, env, options.allowInlineWait !== false);
  const { selection, provider, coordinator, reservation } = admission;

  let upstream: Response;
  try {
    upstream = await provider.invoke(generation, selection.model);
  } catch {
    waitUntil(coordinator.recordOutcome(reservation.reservationId, {
      success: false, cooldown: true, settings: provider.rateLimits,
    }));
    throw new RouterError("upstream_error", `${provider.id} could not be reached.`, 502);
  }

  if (!upstream.ok) {
    const retryAfterMs = retryAfter(upstream);
    waitUntil(coordinator.recordOutcome(reservation.reservationId, {
      success: false,
      cooldown: upstream.status === 429 || upstream.status >= 500,
      observation: { status: upstream.status, retryAfterMs },
      settings: provider.rateLimits,
    }));
    return passthrough(upstream, provider.id, selection.model.id, "upstream-error");
  }

  waitUntil(coordinator.recordOutcome(reservation.reservationId, { success: true, settings: provider.rateLimits }));
  return generation.stream
    ? passthrough(upstream, provider.id, selection.model.id, "policy-selected")
    : await sanitizeCompletion(upstream, provider.id, selection.model.id);
}

async function admitRankedRoute(
  request: GenerationRequest,
  selections: RouteSelection[],
  providers: RegisteredProvider[],
  env: Env,
  allowInlineWait: boolean,
): Promise<ReservedRuntime> {
  const inspected = await inspectCandidates(selections, providers, env);
  const available = inspected.filter((candidate) => candidate.quote.allowed);
  const ranked = rankCandidates(request, available.map(toPolicyCandidate));

  for (const rankedCandidate of ranked) {
    const candidate = available.find((item) => sameCandidate(item, rankedCandidate));
    if (!candidate) continue;
    const reservation = await candidate.coordinator.reserve(candidate.selection.reservedTokens, candidate.provider.rateLimits);
    if (reservation.allowed && reservation.reservationId) {
      return { ...candidate, reservation: reservation as ReservedRuntime["reservation"] };
    }
  }

  const retryAfterMs = earliestRetry(inspected);
  const inlineWait = allowInlineWait ? optionalPositiveNumber(env.MAX_INLINE_WAIT_MS) ?? 0 : 0;
  if (retryAfterMs !== undefined && retryAfterMs <= inlineWait) {
    await sleep(retryAfterMs);
    return admitRankedRoute(request, selections, providers, env, false);
  }
  throw new RouterError(
    "provider_unavailable",
    "All eligible providers are currently rate-limited, cooling down, or lost an admission race.",
    503,
    retryAfterMs,
  );
}

async function inspectCandidates(
  selections: RouteSelection[], providers: RegisteredProvider[], env: Env,
): Promise<CandidateRuntime[]> {
  const candidates = selections.flatMap((selection, catalogOrder): Omit<CandidateRuntime, "quote">[] => {
    const provider = providers.find((item) => item.id === selection.model.provider);
    if (!provider) return [];
    return [{
      selection,
      provider,
      coordinator: env.QUOTA_COORDINATOR.getByName(`${provider.id}:${provider.credentialScope}`),
      catalogOrder,
    }];
  });
  // Provider coordinators are independent Durable Objects, so inspecting them concurrently avoids
  // adding one network round-trip per configured provider to the critical path.
  return Promise.all(candidates.map(async (candidate) => ({
    ...candidate,
    quote: await candidate.coordinator.inspect(candidate.selection.reservedTokens, candidate.provider.rateLimits),
  })));
}

function toPolicyCandidate(candidate: CandidateRuntime): AvailableCandidate {
  return {
    selection: candidate.selection,
    providerId: candidate.provider.id,
    credentialScope: candidate.provider.credentialScope,
    availability: candidate.quote.snapshot,
    catalogOrder: candidate.catalogOrder,
  };
}

function sameCandidate(runtime: CandidateRuntime, policy: AvailableCandidate): boolean {
  return runtime.provider.id === policy.providerId
    && runtime.provider.credentialScope === policy.credentialScope
    && runtime.selection.model.id === policy.selection.model.id;
}

function earliestRetry(candidates: CandidateRuntime[]): number | undefined {
  const values = candidates.map((candidate) => candidate.quote.retryAfterMs)
    .filter((value): value is number => typeof value === "number" && Number.isFinite(value) && value > 0);
  return values.length ? Math.min(...values) : undefined;
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function retryAfter(response: Response): number | undefined {
  for (const name of ["retry-after", "x-ratelimit-reset", "x-ratelimit-reset-requests", "x-ratelimit-reset-tokens"]) {
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
  return new Response(upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers: routedHeaders(upstream.headers, provider, model, reason),
  });
}

/** Removes provider-specific chain-of-thought fields from non-streaming results. */
async function sanitizeCompletion(upstream: Response, provider: string, model: string): Promise<Response> {
  const headers = routedHeaders(upstream.headers, provider, model, "policy-selected");
  try {
    const payload = await upstream.clone().json<Record<string, unknown>>();
    const choices = payload.choices;
    if (Array.isArray(choices)) {
      for (const choice of choices) {
        const message = choice && typeof choice === "object" ? (choice as Record<string, unknown>).message : undefined;
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
    return passthrough(upstream, provider, model, "policy-selected");
  }
}

function routedHeaders(source: Headers, provider: string, model: string, reason: string): Headers {
  const headers = new Headers(source);
  headers.set("x-broke-router-provider", provider);
  headers.set("x-broke-router-model", model);
  headers.set("x-broke-router-route", reason);
  headers.set("x-broke-router-policy", "deterministic-best-fit-v1");
  return headers;
}
