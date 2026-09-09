import { selectRoutes } from "../../core/route";
import { validateChatCompletion } from "../../core/completion";
import { RouterError, type GenerationRequest, type ProviderRateLimitSettings } from "../../core/types";
import { providerForModel, type RegisteredProvider } from "../../providers/openai-compatible";
import { SqliteState } from "./sqlite-state";

export interface LocalIdentity {
  callerId: string;
  environment: string;
  rateLimits: ProviderRateLimitSettings;
}

export interface LocalExecutionOptions {
  upstreamTimeoutMs?: number;
}

export async function executeLocalGeneration(
  request: GenerationRequest,
  providers: RegisteredProvider[],
  state: SqliteState,
  identity: LocalIdentity,
  affinitySecret: string,
  options: LocalExecutionOptions = {},
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
    const deadlineMs = Math.max(1_000, Math.min(
      positive(options.upstreamTimeoutMs, 30_000),
      provider.rateLimits.reservationTtlMs - 1_000,
    ));
    const deadline: any = setTimeout(() => controller.abort(), deadlineMs);
    const clearDeadline = () => clearTimeout(deadline);
    let upstream: Response;
    try {
      upstream = await invokeWithTransportRetry(provider, request, selection.model, controller.signal);
    } catch (error) {
      clearDeadline();
      const detail = error instanceof Error ? `${error.name}: ${error.message}` : "unknown transport error";
      console.error(`Provider invocation failed for ${provider.id}:${provider.credentialScope}: ${detail}`);
      state.settle(providerScope, providerReservation.reservationId, {
        success: false, cooldown: true, retryAfterMs: 5_000, settings: provider.rateLimits,
      });
      lastStatus = 502;
      continue;
    }

    if (upstream.status === 429 || upstream.status >= 500) {
      clearDeadline();
      const delay = retryAfter(upstream);
      const cooldownMs = upstream.status === 429 ? delay : (delay ?? 5_000);
      state.settle(providerScope, providerReservation.reservationId, {
        success: false, cooldown: true, retryAfterMs: cooldownMs, settings: provider.rateLimits,
      });
      retryAfterMs = earliest(retryAfterMs, cooldownMs);
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
    const finalize = (success: boolean, actualTokens?: number) => {
      state.settle(providerScope, providerReservation.reservationId!, { success, actualTokens, settings: provider.rateLimits });
      settleCaller(success, actualTokens);
      // Do not turn an unusable or interrupted answer into future affinity.
      if (success && affinityHash) state.setAffinity(identity.environment, identity.callerId, alias, affinityHash,
        provider.id, provider.credentialScope, selection.model.id);
    };
    if (request.stream) {
      // Once headers arrive, the request timeout has served its purpose. Streaming instead
      // uses an inactivity deadline that is refreshed for every upstream chunk.
      clearDeadline();
      return routed(streamWithFinalizer(upstream, finalize, clearDeadline, deadlineMs), provider.id, selection.model.id);
    }
    const normalized = await sanitize(upstream);
    clearDeadline();
    if (normalized.valid) {
      finalize(true, normalized.actualTokens);
      return routed(normalized.response, provider.id, selection.model.id);
    }
    state.settle(providerScope, providerReservation.reservationId, {
      success: false, actualTokens: normalized.actualTokens, settings: provider.rateLimits,
    });
    lastStatus = 502;
    continue;
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
function positive(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback;
}
function retryAfter(response: Response): number | undefined {
  const raw = response.headers.get("retry-after");
  if (!raw) return undefined;
  const seconds = Number(raw); if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1_000;
  const at = Date.parse(raw); return Number.isFinite(at) ? Math.max(0, at - Date.now()) : undefined;
}
async function invokeWithTransportRetry(
  provider: RegisteredProvider,
  request: GenerationRequest,
  model: Parameters<RegisteredProvider["invoke"]>[1],
  signal: AbortSignal,
): Promise<Response> {
  try {
    return await provider.invoke(request, model, signal);
  } catch (firstError) {
    // A fetch-level failure has no upstream response and consumes no confirmed capacity.
    // Retry it once on the same explicitly selected credential before declaring it unavailable.
    if (signal.aborted) throw firstError;
    await new Promise((resolve) => setTimeout(resolve, 250));
    return provider.invoke(request, model, signal);
  }
}
function routed(response: Response, provider: string, model: string): Response {
  const headers = new Headers(response.headers);
  // Node fetch transparently decompresses upstream bodies but retains these upstream headers.
  headers.delete("content-encoding"); headers.delete("content-length");
  headers.set("x-broke-router-provider", provider); headers.set("x-broke-router-model", model);
  headers.set("x-broke-router-route", "local-sqlite");
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}
function streamWithFinalizer(
  response: Response,
  finalize: (success: boolean, actualTokens?: number) => void,
  clearDeadline: () => void,
  timeoutMs: number,
): Response {
  if (!response.body) { clearDeadline(); finalize(false); return response; }
  const reader = response.body.getReader(); const decoder = new TextDecoder(); const encoder = new TextEncoder();
  let done = false; let pending = ""; let visible = false; let truncated = false; let actualTokens: number | undefined;
  let streamDeadline: ReturnType<typeof setTimeout> | undefined;
  let downstream: ReadableStreamDefaultController<Uint8Array> | undefined;
  const finish = (success: boolean) => {
    if (!done) {
      done = true;
      if (streamDeadline) clearTimeout(streamDeadline);
      clearDeadline();
      finalize(success, actualTokens);
    }
  };
  // Some upstreams resolve fetch headers but never finish their SSE body. Abort the reader
  // as well as the fetch so a stuck stream cannot hold an agent turn or quota lease forever.
  const armStreamDeadline = () => {
    if (streamDeadline) clearTimeout(streamDeadline);
    streamDeadline = setTimeout(() => {
      finish(false);
      void reader.cancel(new Error("Upstream stream inactivity deadline exceeded"));
      downstream?.error(new Error("Upstream stream inactivity deadline exceeded"));
    }, timeoutMs);
  };
  armStreamDeadline();
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      downstream = controller;
      try {
        const chunk = await reader.read();
        if (chunk.done) {
          const tail = sanitize(decoder.decode(), true); if (tail) controller.enqueue(encoder.encode(tail));
          finish(visible && !truncated); controller.close();
        } else {
          armStreamDeadline();
          const output = sanitize(decoder.decode(chunk.value, { stream: true }), false);
          if (output) controller.enqueue(encoder.encode(output));
        }
      }
      catch (error) { finish(false); controller.error(error); }
    },
    async cancel(reason) { await reader.cancel(reason); finish(false); },
  });
  function sanitize(text: string, flush: boolean): string {
    pending += text; const lines = pending.split("\n"); pending = flush ? "" : (lines.pop() ?? "");
    return lines.map((raw) => {
      const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
      const match = /^(\s*data:\s*)(.*)$/.exec(line);
      if (!match || !match[2] || match[2] === "[DONE]") return line;
      try {
        const payload = JSON.parse(match[2]) as Record<string, unknown>;
        const usage = payload.usage as Record<string, unknown> | undefined;
        if (typeof usage?.total_tokens === "number") actualTokens = Math.max(0, usage.total_tokens);
        if (Array.isArray(payload.choices)) for (const item of payload.choices) {
          const choice = item as Record<string, unknown>; if (choice.finish_reason === "length") truncated = true;
          for (const field of ["delta", "message"]) {
            const message = choice[field] as Record<string, unknown> | undefined;
            if (!message) continue;
            delete message.reasoning; delete message.reasoning_content;
            if ((typeof message.content === "string" && message.content.length > 0)
              || (typeof message.refusal === "string" && message.refusal.length > 0)
              || (Array.isArray(message.tool_calls) && message.tool_calls.length > 0)
              || Boolean(message.function_call)) visible = true;
          }
        }
        return `${match[1]}${JSON.stringify(payload)}`;
      } catch { return line; }
    }).join("\n") + (lines.length ? "\n" : "");
  }
  return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
}
async function sanitize(response: Response): Promise<{ response: Response; actualTokens?: number; valid: boolean }> {
  try {
    const payload = await response.clone().json() as Record<string, any>;
    for (const choice of Array.isArray(payload.choices) ? payload.choices : []) {
      if (choice?.message) { delete choice.message.reasoning; delete choice.message.reasoning_content; }
    }
    const actualTokens = typeof payload.usage?.total_tokens === "number" ? payload.usage.total_tokens : undefined;
    const headers = new Headers(response.headers); headers.set("content-type", "application/json");
    headers.delete("content-length"); headers.delete("content-encoding");
    return { response: new Response(JSON.stringify(payload), { status: response.status, headers }), actualTokens, valid: validateChatCompletion(payload).valid };
  } catch { return { response, valid: false }; }
}
async function hmacHex(secret: string, value: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const digest = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
