import { selectRoutes } from "../../core/route";
import { RouterError, type GenerationRequest, type ProviderRateLimitSettings } from "../../core/types";
import { providerForModel, type RegisteredProvider } from "../../providers/openai-compatible";
import { SqliteState } from "./sqlite-state";

export interface LocalIdentity {
  callerId: string;
  environment: string;
  rateLimits: ProviderRateLimitSettings;
}

export async function executeLocalGeneration(
  request: GenerationRequest,
  providers: RegisteredProvider[],
  state: SqliteState,
  identity: LocalIdentity,
  affinitySecret: string,
): Promise<Response> {
  let candidates = selectRoutes(request, providers.flatMap((provider) => provider.models));
  // Consume the tightest currently-capable free bucket first, preserving room in broader
  // accounts for larger bursts. Explicit models still produce a single candidate.
  candidates = [...candidates].sort((left, right) =>
    scarcity(providerForModel(providers, left.model)) - scarcity(providerForModel(providers, right.model)));
  const alias = request.model ?? "free/default";
  const affinityHash = request.route?.affinityKey
    ? await hmacHex(affinitySecret, `${identity.environment}\0${identity.callerId}\0${alias}\0${request.route.affinityKey}`)
    : undefined;
  const sticky = affinityHash ? state.getAffinity(identity.environment, identity.callerId, alias, affinityHash) : undefined;
  if (sticky) candidates = [...candidates].sort((left, right) => Number(matches(right, sticky)) - Number(matches(left, sticky)));

  let retryAfterMs: number | undefined;
  let lastStatus = 503;
  const callerScope = `caller:${identity.environment}:${identity.callerId}`;
  let callerReservationId: string | undefined;
  const reserveCaller = (): void => {
    if (callerReservationId) return;
    const reservation = state.reserve(callerScope, candidates[0]?.reservedTokens ?? 1, identity.rateLimits);
    if (!reservation.allowed || !reservation.reservationId) {
      throw new RouterError("caller_rate_limited", "Caller rate limit exceeded.", 429, reservation.retryAfterMs);
    }
    callerReservationId = reservation.reservationId;
  };
  const settleCaller = (success: boolean, actualTokens?: number): void => {
    if (!callerReservationId) return;
    state.settle(callerScope, callerReservationId, { success, actualTokens, settings: identity.rateLimits });
    callerReservationId = undefined;
  };
  for (const selection of candidates) {
    const provider = providerForModel(providers, selection.model);
    if (!provider) continue;
    const providerScope = `provider:${provider.id}:${provider.credentialScope}`;
    const providerQuote = state.inspect(providerScope, selection.reservedTokens, provider.rateLimits);
    if (!providerQuote.allowed) { retryAfterMs = earliest(retryAfterMs, providerQuote.retryAfterMs); continue; }
    reserveCaller();
    const providerReservation = state.reserve(providerScope, selection.reservedTokens, provider.rateLimits);
    if (!providerReservation.allowed || !providerReservation.reservationId) {
      retryAfterMs = earliest(retryAfterMs, providerReservation.retryAfterMs);
      continue;
    }

    const controller = new AbortController();
    // A live reservation must never outlast the upstream request. This keeps a hung request
    // from being reclaimed as stale and violating the credential's concurrency ceiling.
    const deadlineMs = Math.max(1_000, Math.min(90_000, provider.rateLimits.reservationTtlMs - 1_000));
    const deadline: any = setTimeout(() => controller.abort(), deadlineMs);
    const clearDeadline = () => clearTimeout(deadline);
    let upstream: Response;
    try {
      upstream = await provider.invoke(request, selection.model, controller.signal);
    } catch (error) {
      clearDeadline();
      const detail = error instanceof Error ? `${error.name}: ${error.message}` : "unknown transport error";
      console.error(`Provider invocation failed for ${provider.id}:${provider.credentialScope}: ${detail}`);
      state.settle(providerScope, providerReservation.reservationId, { success: false, cooldown: true, settings: provider.rateLimits });
      lastStatus = 502;
      continue;
    }

    if (upstream.status === 429 || upstream.status >= 500) {
      clearDeadline();
      const delay = retryAfter(upstream);
      state.settle(providerScope, providerReservation.reservationId, {
        success: false, cooldown: true, retryAfterMs: delay, settings: provider.rateLimits,
      });
      retryAfterMs = earliest(retryAfterMs, delay);
      lastStatus = upstream.status;
      await upstream.body?.cancel().catch(() => undefined);
      continue;
    }

    if (!upstream.ok) {
      clearDeadline();
      state.settle(providerScope, providerReservation.reservationId, { success: false, settings: provider.rateLimits });
      settleCaller(false);
      return routed(upstream, provider.id, selection.model.id);
    }
    if (affinityHash) state.setAffinity(identity.environment, identity.callerId, alias, affinityHash,
      provider.id, provider.credentialScope, selection.model.id);
    const finalize = (success: boolean, actualTokens?: number) => {
      state.settle(providerScope, providerReservation.reservationId!, { success, actualTokens, settings: provider.rateLimits });
      settleCaller(success, actualTokens);
    };
    if (request.stream) return routed(streamWithFinalizer(upstream, finalize, clearDeadline), provider.id, selection.model.id);
    const normalized = await sanitize(upstream);
    clearDeadline();
    finalize(true, normalized.actualTokens);
    return routed(normalized.response, provider.id, selection.model.id);
  }
  settleCaller(false);
  throw new RouterError("provider_unavailable", `All eligible provider accounts are unavailable (last upstream status ${lastStatus}).`, 503, retryAfterMs);
}

function matches(selection: ReturnType<typeof selectRoutes>[number], sticky: { provider: string; credentialScope: string; modelId: string }): boolean {
  return selection.model.provider === sticky.provider && selection.model.credentialScope === sticky.credentialScope
    && selection.model.id === sticky.modelId;
}
function scarcity(provider: RegisteredProvider | undefined): number {
  const requests = provider?.rateLimits.requests;
  return requests ? requests.limit / requests.windowMs : Number.POSITIVE_INFINITY;
}
function earliest(left: number | undefined, right: number | undefined): number | undefined {
  if (right === undefined) return left; return left === undefined ? right : Math.min(left, right);
}
function retryAfter(response: Response): number | undefined {
  const raw = response.headers.get("retry-after");
  if (!raw) return undefined;
  const seconds = Number(raw); if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1_000;
  const at = Date.parse(raw); return Number.isFinite(at) ? Math.max(0, at - Date.now()) : undefined;
}
function routed(response: Response, provider: string, model: string): Response {
  const headers = new Headers(response.headers);
  // Node fetch transparently decompresses upstream bodies but retains these upstream headers.
  headers.delete("content-encoding"); headers.delete("content-length");
  headers.set("x-broke-router-provider", provider); headers.set("x-broke-router-model", model);
  headers.set("x-broke-router-route", "local-sqlite");
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}
function streamWithFinalizer(response: Response, finalize: (success: boolean) => void, clearDeadline: () => void): Response {
  if (!response.body) { clearDeadline(); finalize(true); return response; }
  const reader = response.body.getReader(); let done = false;
  const finish = (success: boolean) => { if (!done) { done = true; clearDeadline(); finalize(success); } };
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try { const chunk = await reader.read(); if (chunk.done) { finish(true); controller.close(); } else controller.enqueue(chunk.value); }
      catch (error) { finish(false); controller.error(error); }
    },
    async cancel(reason) { await reader.cancel(reason); finish(false); },
  });
  return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
}
async function sanitize(response: Response): Promise<{ response: Response; actualTokens?: number }> {
  try {
    const payload = await response.clone().json() as Record<string, any>;
    for (const choice of Array.isArray(payload.choices) ? payload.choices : []) {
      if (choice?.message) { delete choice.message.reasoning; delete choice.message.reasoning_content; }
    }
    const actualTokens = typeof payload.usage?.total_tokens === "number" ? payload.usage.total_tokens : undefined;
    const headers = new Headers(response.headers); headers.set("content-type", "application/json");
    headers.delete("content-length"); headers.delete("content-encoding");
    return { response: new Response(JSON.stringify(payload), { status: response.status, headers }), actualTokens };
  } catch { return { response }; }
}
async function hmacHex(secret: string, value: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const digest = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
