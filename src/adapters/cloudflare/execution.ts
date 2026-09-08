import type { Env } from "../../config";
import type { PolicyDecision, PolicyMode } from "../../core/adaptive-policy";
import { validateChatCompletion, type CompletionFailure } from "../../core/completion";
import { selectRoutes } from "../../core/route";
import { RouterError, type GenerationRequest, type ProviderRateLimitSettings, type RouteSelection } from "../../core/types";
import { applyWorkflowContext, workflowContextKey, type WorkflowRecord } from "../../core/workflow";
import { providerForModel, type RegisteredProvider } from "../../providers/openai-compatible";
import type { QuotaCoordinator, ReservationResult } from "./quota-coordinator";
import { optionalPositiveNumber, registeredProviders } from "./provider-registry";
import { routingCoordinator } from "./routing-coordinator-client";
import type { RoutingCoordinator } from "./routing-coordinator";
import type { CallOutcomeEvent, PolicyControl, RoutingDecisionEvent } from "./routing-state";
import type { WorkflowCoordinator } from "./workflow-coordinator";

type WaitUntil = (promise: Promise<unknown>) => void;
type PhaseName = typeof PHASE_NAMES[number];
type PhaseTimings = Partial<Record<PhaseName, number>>;

const PHASE_NAMES = [
  "br_workflow",
  "br_caller_inspect",
  "br_plan_reserve",
  "br_caller_reserve",
  "br_workflow_lease",
  "br_inline_wait",
  "br_normalize",
] as const;

export interface ExecutionIdentity {
  callerId: string;
  environment: string;
  rateLimits?: ProviderRateLimitSettings;
}

interface CandidateRuntime {
  selection: RouteSelection;
  provider: RegisteredProvider;
  catalogOrder: number;
}

interface ReservedRuntime extends CandidateRuntime {
  coordinator: DurableObjectStub<RoutingCoordinator>;
  reservation: { reservationId: string };
  policy: PolicyDecision;
  reservationRank: number;
}

/** Shared, observed, multi-provider execution path for interactive calls and durable jobs. */
export async function executeGeneration(
  generation: GenerationRequest,
  env: Env,
  waitUntil: WaitUntil,
  options: { allowInlineWait?: boolean; identity?: ExecutionIdentity; requestStartedAt?: number } = {},
): Promise<Response> {
  const requestStartedAt = options.requestStartedAt ?? performance.now();
  let providerDurationMs = 0;
  const phases: PhaseTimings = {};
  const identity = options.identity ?? { callerId: "system", environment: "development" };
  const routingState = env.ROUTING_STATE.getByName(identity.environment);
  const providerCoordinator = routingCoordinator(env, identity.environment);
  const workflowContext = await measurePhase(phases, "br_workflow", () => inspectWorkflow(generation, identity, env));
  const workflow = workflowContext?.workflow;
  const workflowCoordinator = workflowContext?.coordinator;
  const effectiveGeneration = workflow
    ? applyWorkflowContext(withoutUntrustedAffinity(generation), workflow)
    : withoutUntrustedAffinity(generation);
  const providers = registeredProviders(env);
  const selections = selectRoutes(effectiveGeneration, providers.flatMap((provider) => provider.models));
  const callerAdmission = await measurePhase(phases, "br_caller_inspect", () => inspectCallerAdmission(
    identity, Math.max(...selections.map((selection) => selection.reservedTokens)), env,
  ));
  let callerReservation: (ReservationResult & { allowed: true; reservationId: string }) | undefined;
  let workflowCallId: string | undefined;
  let logicalFinalized = false;
  let totalActualTokens = 0;
  let consumedProviderCapacity = false;
  const finalizeLogical = (success: boolean): void => {
    if (logicalFinalized) return;
    logicalFinalized = true;
    const tasks: Promise<unknown>[] = [];
    if (callerAdmission && callerReservation) {
      tasks.push(callerAdmission.coordinator.recordOutcome(callerReservation.reservationId, {
        success: consumedProviderCapacity,
        actualTokens: totalActualTokens || undefined,
        settings: callerAdmission.settings,
      }));
    }
    if (workflowCallId && workflowCoordinator) {
      tasks.push(workflowCoordinator.finishCall(workflowCallId, success, totalActualTokens || undefined));
    }
    if (tasks.length) waitUntil(Promise.all(tasks));
  };

  const excludedProviders = new Set<string>();
  const attemptedProviders: string[] = [];
  const providerCount = new Set(providers.map(providerKey)).size;
  const maxAttempts = Math.min(providerCount, Math.max(1, Math.floor(optionalPositiveNumber(env.MAX_PROVIDER_ATTEMPTS) ?? 2)));
  let lastFailure: Response | undefined;
  let lastError: RouterError | undefined;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    let admission: ReservedRuntime;
    try {
      admission = await admitRankedRoute(
        effectiveGeneration, selections, providers, env, providerCoordinator, identity,
        options.allowInlineWait !== false && attempt === 1, excludedProviders, phases,
      );
    } catch (error) {
      if (attemptedProviders.length) break;
      throw error;
    }
    const { selection, provider, coordinator, reservation, policy, reservationRank } = admission;
    const currentProviderKey = providerKey(provider);
    attemptedProviders.push(provider.id);
    excludedProviders.add(currentProviderKey);

    if (callerAdmission && !callerReservation) {
      const reserved = await measurePhase(phases, "br_caller_reserve", () => callerAdmission.coordinator.reserve(
        selection.reservedTokens, callerAdmission.settings,
      ));
      if (!reserved.allowed || !reserved.reservationId) {
        await coordinator.recordProviderOutcome(currentProviderKey, reservation.reservationId, {
          quotaSuccess: false, settings: provider.rateLimits,
        });
        throw new RouterError(
          "caller_rate_limited", "Caller capacity changed before it could be reserved.", 429, reserved.retryAfterMs,
        );
      }
      callerReservation = reserved as typeof reserved & { allowed: true; reservationId: string };
    }

    const decisionId = crypto.randomUUID();
    try {
      if (!workflowCallId && workflow && workflowCoordinator) {
        const lease = await measurePhase(phases, "br_workflow_lease", () => workflowCoordinator.beginCall(
          workflow.id, identity.callerId, decisionId, provider.id, selection.model.id,
        ));
        workflowCallId = lease.callId;
      }
    } catch (error) {
      await coordinator.recordProviderOutcome(currentProviderKey, reservation.reservationId, {
        quotaSuccess: false, settings: provider.rateLimits,
      });
      finalizeLogical(false);
      throw error;
    }

    waitUntil(routingState.recordDecision(decisionMetadata(
      decisionId, effectiveGeneration, identity, workflow, admission, reservationRank,
    )));
    const startedAt = Date.now();
    let attemptFinalized = false;
    const finalizeAttempt = (result: {
      success: boolean; status: number; actualTokens?: number; timeToFirstTokenMs?: number;
      quotaSuccess: boolean; cooldown?: boolean; retryAfterMs?: number;
    }): void => {
      if (attemptFinalized) return;
      attemptFinalized = true;
      const completedAt = Date.now();
      const learning = callOutcome(
        decisionId, identity, effectiveGeneration, provider.id, selection.model.id,
        startedAt, completedAt, result,
      );
      waitUntil(Promise.all([
        coordinator.recordProviderOutcome(currentProviderKey, reservation.reservationId, {
          quotaSuccess: result.quotaSuccess,
          cooldown: result.cooldown,
          actualTokens: result.actualTokens,
          observation: result.cooldown ? { status: result.status, retryAfterMs: result.retryAfterMs } : undefined,
          settings: provider.rateLimits,
          learning,
        }),
        routingState.recordCallOutcome(learning),
      ]));
    };

    let upstream: Response;
    const providerStartedAt = performance.now();
    try {
      upstream = await provider.invoke(effectiveGeneration, selection.model);
    } catch {
      providerDurationMs += performance.now() - providerStartedAt;
      finalizeAttempt({ success: false, status: 502, quotaSuccess: false, cooldown: true });
      lastError = new RouterError("upstream_error", `${provider.id} could not be reached.`, 502);
      continue;
    }
    providerDurationMs += performance.now() - providerStartedAt;

    if (!upstream.ok) {
      const retryAfterMs = retryAfter(upstream);
      finalizeAttempt({
        success: false, status: upstream.status, quotaSuccess: false,
        cooldown: upstream.status === 429 || upstream.status >= 500, retryAfterMs,
      });
      lastFailure = withAttemptHeaders(
        passthrough(upstream, provider.id, selection.model.id, "upstream-error", policy.activePolicy),
        attempt, attemptedProviders,
      );
      continue;
    }

    consumedProviderCapacity = true;
    if (effectiveGeneration.stream) {
      return withServerTiming(observedStream(
        upstream, provider.id, selection.model.id, policy.activePolicy, startedAt,
        (result) => {
          if (result.actualTokens !== undefined) totalActualTokens += result.actualTokens;
          finalizeAttempt(result);
          finalizeLogical(result.success);
        }, attempt, attemptedProviders,
      ), requestStartedAt, providerDurationMs, "headers", phases);
    }

    const reason = attempt > 1 ? "fallback-selected" : "policy-selected";
    const normalizationStartedAt = performance.now();
    const sanitized = await sanitizeCompletion(upstream, provider.id, selection.model.id, reason, policy.activePolicy);
    providerDurationMs += sanitized.providerBodyReadMs;
    addPhase(phases, "br_normalize", Math.max(
      0, performance.now() - normalizationStartedAt - sanitized.providerBodyReadMs,
    ));
    if (sanitized.actualTokens !== undefined) totalActualTokens += sanitized.actualTokens;
    if (sanitized.valid) {
      finalizeAttempt({ success: true, status: upstream.status, quotaSuccess: true, actualTokens: sanitized.actualTokens });
      finalizeLogical(true);
      return withServerTiming(
        withAttemptHeaders(sanitized.response, attempt, attemptedProviders),
        requestStartedAt,
        providerDurationMs,
        "complete",
        phases,
      );
    }

    finalizeAttempt({ success: false, status: upstream.status, quotaSuccess: true, actualTokens: sanitized.actualTokens });
    lastFailure = semanticFailure(
      provider.id, selection.model.id, policy.activePolicy, sanitized.failure ?? "empty_output",
      attempt, attemptedProviders,
    );
  }

  finalizeLogical(false);
  if (lastFailure) return withServerTiming(lastFailure, requestStartedAt, providerDurationMs, "complete", phases);
  throw lastError ?? new RouterError("upstream_error", "No provider returned a usable completion.", 502);
}

async function inspectCallerAdmission(
  identity: ExecutionIdentity, reservedTokens: number, env: Env,
): Promise<{ coordinator: DurableObjectStub<QuotaCoordinator>; settings: ProviderRateLimitSettings } | undefined> {
  const settings = identity.rateLimits;
  if (!settings || !hasLimits(settings)) return undefined;
  const coordinator = env.CALLER_QUOTA_COORDINATOR.getByName(`${identity.environment}:${identity.callerId}`);
  const quote = await coordinator.inspect(reservedTokens, settings);
  if (!quote.allowed) {
    throw new RouterError("caller_rate_limited", "Caller request, token, daily, or concurrency limit is reached.", 429, quote.retryAfterMs);
  }
  return { coordinator, settings };
}

async function admitRankedRoute(
  request: GenerationRequest,
  selections: RouteSelection[],
  providers: RegisteredProvider[],
  env: Env,
  coordinator: DurableObjectStub<RoutingCoordinator>,
  identity: ExecutionIdentity,
  allowInlineWait: boolean,
  excludedProviders: ReadonlySet<string> = new Set(),
  phases: PhaseTimings = {},
): Promise<ReservedRuntime> {
  const contextKey = workflowContextKey(request);
  const candidates = candidateRuntimes(selections, providers);
  const planned = await measurePhase(phases, "br_plan_reserve", () => coordinator.planAndReserve({
    request: {
      model: request.model,
      max_tokens: request.max_tokens,
      stream: request.stream,
      tools: request.tools,
      route: request.route,
    },
    callerId: identity.callerId,
    environment: identity.environment,
    contextKey,
    candidates: candidates.map((candidate) => ({
      selection: candidate.selection,
      providerId: candidate.provider.id,
      credentialScope: candidate.provider.credentialScope,
      rateLimits: candidate.provider.rateLimits,
      catalogOrder: candidate.catalogOrder,
    })),
    excludedProviderKeys: [...excludedProviders],
    defaultControl: defaultPolicyControl(env),
  }));

  if (planned.allowed && planned.reservation) {
    const reserved = planned.reservation;
    const candidate = candidates.find((item) => providerKey(item.provider) === providerKeyFromParts(
      reserved.providerId, reserved.credentialScope,
    ) && item.selection.model.id === reserved.modelId);
    if (!candidate) throw new RouterError("provider_unavailable", "Coordinator selected an unknown route.", 503);
    return {
      ...candidate,
      coordinator,
      reservation: { reservationId: reserved.reservationId },
      policy: reserved.policy,
      reservationRank: reserved.reservationRank,
    };
  }

  const retryAfterMs = planned.retryAfterMs;
  const inlineWait = allowInlineWait ? optionalPositiveNumber(env.MAX_INLINE_WAIT_MS) ?? 0 : 0;
  if (retryAfterMs !== undefined && retryAfterMs <= inlineWait) {
    await measurePhase(phases, "br_inline_wait", () => sleep(retryAfterMs));
    return admitRankedRoute(request, selections, providers, env, coordinator, identity, false, excludedProviders, phases);
  }
  throw new RouterError(
    "provider_unavailable",
    "All eligible providers are currently rate-limited, cooling down, or lost an admission race.",
    503,
    retryAfterMs,
  );
}

async function inspectWorkflow(
  request: GenerationRequest,
  identity: ExecutionIdentity,
  env: Env,
): Promise<{ workflow: WorkflowRecord; coordinator: DurableObjectStub<WorkflowCoordinator> } | undefined> {
  if (!request.route?.workflowId) return undefined;
  const coordinator = env.WORKFLOW_COORDINATOR.getByName(request.route.workflowId);
  return { workflow: await coordinator.inspectForCall(request.route.workflowId, identity.callerId), coordinator };
}

function withoutUntrustedAffinity(request: GenerationRequest): GenerationRequest {
  if (!request.route?.preferredProviderId) return request;
  const route = { ...request.route };
  delete route.preferredProviderId;
  return { ...request, route };
}

function candidateRuntimes(selections: RouteSelection[], providers: RegisteredProvider[]): CandidateRuntime[] {
  return selections.flatMap((selection, catalogOrder): CandidateRuntime[] => {
    const provider = providerForModel(providers, selection.model);
    if (!provider) return [];
    return [{ selection, provider, catalogOrder }];
  });
}

function decisionMetadata(
  id: string,
  request: GenerationRequest,
  identity: ExecutionIdentity,
  workflow: WorkflowRecord | undefined,
  admission: ReservedRuntime,
  reservationRank: number,
): RoutingDecisionEvent {
  const selected = admission.policy.ranked[reservationRank];
  return {
    id,
    createdAt: Date.now(),
    callerId: identity.callerId,
    environment: identity.environment,
    contextKey: workflowContextKey(request),
    workflowId: workflow?.id,
    selectedProvider: admission.provider.id,
    selectedModel: admission.selection.model.id,
    reservationRank,
    activePolicy: admission.policy.activePolicy,
    policyVersion: admission.policy.policyVersion,
    baselineWinner: admission.policy.baselineWinner,
    shadowWinner: admission.policy.shadowWinner,
    propensity: reservationRank === 0 ? admission.policy.propensity : 0,
    explored: admission.policy.explored,
    features: {
      workflowType: request.route?.workflowType ?? "single-turn",
      qualityTier: request.route?.qualityTier ?? request.route?.tier ?? "balanced",
      expectedCalls: positive(request.route?.expectedCalls, 1),
      maxConcurrency: positive(request.route?.maxConcurrency, 1),
      estimatedTotalTokens: positive(request.route?.estimatedTotalTokens, admission.selection.reservedTokens),
      requestedOutputTokens: positive(request.max_tokens, 1_024),
      streaming: request.stream === true,
      tools: Boolean(request.tools?.length),
    },
    candidates: admission.policy.ranked.map((candidate) => ({
      providerId: candidate.providerId,
      modelId: candidate.selection.model.id,
      reservedTokens: candidate.selection.reservedTokens,
      ...candidate.availability,
      baselineScore: candidate.score,
      learnedScore: candidate.learnedScore,
    })),
  };
}

function callOutcome(
  decisionId: string,
  identity: ExecutionIdentity,
  request: GenerationRequest,
  providerId: string,
  modelId: string,
  startedAt: number,
  completedAt: number,
  result: { success: boolean; status: number; actualTokens?: number; timeToFirstTokenMs?: number },
): CallOutcomeEvent {
  return {
    decisionId, completedAt, callerId: identity.callerId, environment: identity.environment,
    contextKey: workflowContextKey(request), workflowId: request.route?.workflowId,
    providerId, modelId, success: result.success, status: result.status,
    rateLimited: result.status === 429, latencyMs: completedAt - startedAt,
    timeToFirstTokenMs: result.timeToFirstTokenMs, actualTokens: result.actualTokens,
  };
}

function observedStream(
  upstream: Response,
  provider: string,
  model: string,
  policy: string,
  startedAt: number,
  finalize: (result: {
    success: boolean; status: number; quotaSuccess: boolean; timeToFirstTokenMs?: number; actualTokens?: number;
  }) => void,
  attempt: number,
  attemptedProviders: string[],
): Response {
  if (!upstream.body) {
    finalize({ success: false, status: upstream.status, quotaSuccess: true });
    return withAttemptHeaders(passthrough(upstream, provider, model, "policy-selected", policy), attempt, attemptedProviders);
  }
  const reader = upstream.body.getReader();
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let pending = "";
  let visibleOutput = false;
  let truncated = false;
  let actualTokens: number | undefined;
  let ttft: number | undefined;
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const chunk = await reader.read();
        if (chunk.done) {
          const tail = sanitizeSse(decoder.decode(), true);
          if (tail.length) controller.enqueue(encoder.encode(tail));
          finalize({
            success: visibleOutput && !truncated,
            status: upstream.status,
            quotaSuccess: true,
            timeToFirstTokenMs: ttft,
            actualTokens,
          });
          controller.close();
          return;
        }
        const output = sanitizeSse(decoder.decode(chunk.value, { stream: true }), false);
        if (output.length) controller.enqueue(encoder.encode(output));
      } catch (error) {
        finalize({ success: false, status: 502, quotaSuccess: true, timeToFirstTokenMs: ttft, actualTokens });
        controller.error(error);
      }
    },
    async cancel(reason) {
      await reader.cancel(reason);
      finalize({ success: false, status: 499, quotaSuccess: true, timeToFirstTokenMs: ttft, actualTokens });
    },
  });

  function sanitizeSse(text: string, flush: boolean): string {
    pending += text;
    const lines = pending.split("\n");
    if (!flush) pending = lines.pop() ?? "";
    else pending = "";
    if (lines.length === 0 || (flush && lines.length === 1 && lines[0] === "")) return "";
    return `${lines.map(sanitizeSseLine).join("\n")}\n`;
  }

  function sanitizeSseLine(rawLine: string): string {
    const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
    const match = /^(\s*data:\s*)(.*)$/.exec(line);
    if (!match || match[2] === "[DONE]" || !match[2]) return line;
    try {
      const payload = JSON.parse(match[2]) as Record<string, unknown>;
      const usage = record(payload.usage);
      if (typeof usage?.total_tokens === "number") actualTokens = Math.max(0, usage.total_tokens);
      if (Array.isArray(payload.choices)) {
        for (const item of payload.choices) {
          const choice = record(item);
          if (!choice) continue;
          if (choice.finish_reason === "length") truncated = true;
          for (const field of ["delta", "message"] as const) {
            const message = record(choice[field]);
            if (!message) continue;
            delete message.reasoning;
            delete message.reasoning_content;
            if (streamMessageHasOutput(message)) {
              visibleOutput = true;
              ttft ??= Date.now() - startedAt;
            }
          }
        }
      }
      return `${match[1]}${JSON.stringify(payload)}`;
    } catch {
      return line;
    }
  }

  const headers = routedHeaders(upstream.headers, provider, model, "policy-selected", policy);
  return withAttemptHeaders(
    new Response(body, { status: upstream.status, statusText: upstream.statusText, headers }),
    attempt,
    attemptedProviders,
  );
}

function streamMessageHasOutput(message: Record<string, unknown>): boolean {
  return (typeof message.content === "string" && message.content.length > 0)
    || (typeof message.refusal === "string" && message.refusal.length > 0)
    || (Array.isArray(message.tool_calls) && message.tool_calls.length > 0)
    || Boolean(record(message.function_call));
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
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

function passthrough(upstream: Response, provider: string, model: string, reason: string, policy: string): Response {
  return new Response(upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers: routedHeaders(upstream.headers, provider, model, reason, policy),
  });
}

async function sanitizeCompletion(
  upstream: Response, provider: string, model: string, reason: string, policy: string,
): Promise<{
  response: Response; actualTokens?: number; valid: boolean; failure?: CompletionFailure; providerBodyReadMs: number;
}> {
  const headers = routedHeaders(upstream.headers, provider, model, reason, policy);
  const bodyStartedAt = performance.now();
  let body: string;
  try {
    body = await upstream.clone().text();
  } catch {
    return {
      response: passthrough(upstream, provider, model, reason, policy),
      valid: false,
      failure: "empty_output",
      providerBodyReadMs: performance.now() - bodyStartedAt,
    };
  }
  const providerBodyReadMs = performance.now() - bodyStartedAt;
  try {
    const payload = JSON.parse(body) as Record<string, unknown>;
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
    const usage = payload.usage && typeof payload.usage === "object" ? payload.usage as Record<string, unknown> : undefined;
    const actualTokens = typeof usage?.total_tokens === "number" ? Math.max(0, usage.total_tokens) : undefined;
    const validation = validateChatCompletion(payload);
    headers.set("content-type", "application/json");
    headers.delete("content-length");
    headers.delete("content-encoding");
    return {
      response: new Response(JSON.stringify(payload), { status: upstream.status, statusText: upstream.statusText, headers }),
      actualTokens,
      providerBodyReadMs,
      ...validation,
    };
  } catch {
    return {
      response: new Response(body, {
        status: upstream.status,
        statusText: upstream.statusText,
        headers: routedHeaders(upstream.headers, provider, model, reason, policy),
      }),
      valid: false,
      failure: "empty_output",
      providerBodyReadMs,
    };
  }
}

function semanticFailure(
  provider: string,
  model: string,
  policy: string,
  failure: CompletionFailure,
  attempt: number,
  attemptedProviders: string[],
): Response {
  const message = failure === "truncated_output"
    ? "Provider exhausted the output-token budget before completing a usable answer."
    : "Provider returned no usable visible content or tool call.";
  const headers = routedHeaders(new Headers({ "content-type": "application/json" }), provider, model, "semantic-invalid", policy);
  const response = new Response(JSON.stringify({
    error: { message, type: "invalid_upstream_response", code: failure },
  }), { status: 502, headers });
  return withAttemptHeaders(response, attempt, attemptedProviders);
}

function withAttemptHeaders(response: Response, attempt: number, attemptedProviders: string[]): Response {
  const headers = new Headers(response.headers);
  headers.set("x-broke-router-attempts", String(attempt));
  if (attemptedProviders.length > 1) {
    headers.set("x-broke-router-fallback-from", attemptedProviders.slice(0, -1).join(","));
  }
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

function withServerTiming(
  response: Response,
  requestStartedAt: number,
  providerDurationMs: number,
  providerMeasurement: "headers" | "complete",
  phases: PhaseTimings,
): Response {
  const serverDurationMs = Math.max(0, performance.now() - requestStartedAt);
  const boundedProviderMs = Math.max(0, Math.min(serverDurationMs, providerDurationMs));
  const routerDurationMs = Math.max(0, serverDurationMs - boundedProviderMs);
  const headers = new Headers(response.headers);
  const measuredRouterPhasesMs = PHASE_NAMES.reduce((total, name) => total + (phases[name] ?? 0), 0);
  const otherDurationMs = Math.max(0, routerDurationMs - measuredRouterPhasesMs);
  const timing = [
    `br_provider;dur=${timingValue(boundedProviderMs)}`,
    `br_router;dur=${timingValue(routerDurationMs)}`,
    `br_total;dur=${timingValue(serverDurationMs)}`,
    ...PHASE_NAMES.map((name) => `${name};dur=${timingValue(phases[name] ?? 0)}`),
    `br_other;dur=${timingValue(otherDurationMs)}`,
  ].join(", ");
  const existing = headers.get("server-timing");
  headers.set("server-timing", existing ? `${existing}, ${timing}` : timing);
  headers.set("x-broke-router-provider-timing", providerMeasurement);
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

async function measurePhase<T>(phases: PhaseTimings, name: PhaseName, operation: () => Promise<T>): Promise<T> {
  const startedAt = performance.now();
  try {
    return await operation();
  } finally {
    addPhase(phases, name, performance.now() - startedAt);
  }
}

function addPhase(phases: PhaseTimings, name: PhaseName, durationMs: number): void {
  phases[name] = (phases[name] ?? 0) + Math.max(0, durationMs);
}

function timingValue(value: number): string {
  return value.toFixed(3);
}

function providerKey(provider: Pick<RegisteredProvider, "id" | "credentialScope">): string {
  return `${provider.id}:${provider.credentialScope}`;
}

function providerKeyFromParts(providerId: string, credentialScope: string): string {
  return `${providerId}:${credentialScope}`;
}

function routedHeaders(source: Headers, provider: string, model: string, reason: string, policy: string): Headers {
  const headers = new Headers(source);
  headers.set("x-broke-router-provider", provider);
  headers.set("x-broke-router-model", model);
  headers.set("x-broke-router-route", reason);
  headers.set("x-broke-router-policy", policy);
  return headers;
}

function policyMode(value: string | undefined): PolicyMode {
  return value === "adaptive" || value === "shadow" ? value : "baseline";
}
export function defaultPolicyControl(env: Pick<Env, "ROUTING_POLICY_MODE" | "ADAPTIVE_EXPLORATION_RATE" | "ADAPTIVE_MIN_OBSERVATIONS">): PolicyControl {
  return {
    mode: policyMode(env.ROUTING_POLICY_MODE),
    explorationRate: numericSetting(env.ADAPTIVE_EXPLORATION_RATE, 0.05),
    minObservations: Math.floor(numericSetting(env.ADAPTIVE_MIN_OBSERVATIONS, 30)),
  };
}
function numericSetting(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}
function positive(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback;
}
function hasLimits(settings: ProviderRateLimitSettings): boolean {
  return settings.dailySafetyBudgetTokens > 0 || Boolean(settings.requests || settings.tokens || settings.maxConcurrent);
}
