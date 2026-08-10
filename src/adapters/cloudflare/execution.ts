import type { Env } from "../../config";
import { decidePolicy, type PolicyDecision, type PolicyMode, type RankedPolicyCandidate } from "../../core/adaptive-policy";
import type { AvailableCandidate } from "../../core/policy";
import { selectRoutes } from "../../core/route";
import { RouterError, type GenerationRequest, type ProviderRateLimitSettings, type RouteSelection } from "../../core/types";
import { applyWorkflowContext, workflowContextKey, type WorkflowRecord } from "../../core/workflow";
import type { RegisteredProvider } from "../../providers/openai-compatible";
import type { AdmissionQuote, QuotaCoordinator, ReservationResult } from "./quota-coordinator";
import { optionalPositiveNumber, registeredProviders } from "./provider-registry";
import type { CallOutcomeEvent, PolicyControl, RoutingDecisionEvent, RoutingState } from "./routing-state";
import type { WorkflowCoordinator } from "./workflow-coordinator";

type WaitUntil = (promise: Promise<unknown>) => void;

export interface ExecutionIdentity {
  callerId: string;
  environment: string;
  rateLimits?: ProviderRateLimitSettings;
}

interface CandidateRuntime {
  selection: RouteSelection;
  provider: RegisteredProvider;
  coordinator: DurableObjectStub<QuotaCoordinator>;
  quote: AdmissionQuote;
  catalogOrder: number;
}

interface ReservedRuntime extends CandidateRuntime {
  reservation: ReservationResult & { allowed: true; reservationId: string };
  policy: PolicyDecision;
  reservationRank: number;
}

/** Shared, observed, multi-provider execution path for interactive calls and durable jobs. */
export async function executeGeneration(
  generation: GenerationRequest,
  env: Env,
  waitUntil: WaitUntil,
  options: { allowInlineWait?: boolean; identity?: ExecutionIdentity } = {},
): Promise<Response> {
  const identity = options.identity ?? { callerId: "system", environment: "development" };
  const routingState = env.ROUTING_STATE.getByName(identity.environment);
  const workflowContext = await inspectWorkflow(generation, identity, env);
  const workflow = workflowContext?.workflow;
  const workflowCoordinator = workflowContext?.coordinator;
  const effectiveGeneration = workflow
    ? applyWorkflowContext(withoutUntrustedAffinity(generation), workflow)
    : withoutUntrustedAffinity(generation);
  const providers = registeredProviders(env);
  const selections = selectRoutes(effectiveGeneration, providers.flatMap((provider) => provider.models));
  const callerAdmission = await inspectCallerAdmission(identity, selections[0].reservedTokens, env);
  const admission = await admitRankedRoute(
    effectiveGeneration, selections, providers, env, routingState, identity,
    options.allowInlineWait !== false,
  );
  const { selection, provider, coordinator, reservation, policy, reservationRank } = admission;
  let callerReservation: (ReservationResult & { allowed: true; reservationId: string }) | undefined;
  if (callerAdmission) {
    const reserved = await callerAdmission.coordinator.reserve(selection.reservedTokens, callerAdmission.settings);
    if (!reserved.allowed || !reserved.reservationId) {
      await coordinator.recordOutcome(reservation.reservationId, { success: false, settings: provider.rateLimits });
      throw new RouterError(
        "caller_rate_limited", "Caller capacity changed before it could be reserved.", 429, reserved.retryAfterMs,
      );
    }
    callerReservation = reserved as typeof reserved & { allowed: true; reservationId: string };
  }
  const decisionId = crypto.randomUUID();
  let workflowCallId: string | undefined;
  try {
    if (workflow && workflowCoordinator) {
      const lease = await workflowCoordinator.beginCall(
        workflow.id, identity.callerId, decisionId, provider.id, selection.model.id,
      );
      workflowCallId = lease.callId;
    }
  } catch (error) {
    await coordinator.recordOutcome(reservation.reservationId, { success: false, settings: provider.rateLimits });
    if (callerAdmission && callerReservation) {
      await callerAdmission.coordinator.recordOutcome(callerReservation.reservationId, {
        success: false, settings: callerAdmission.settings,
      });
    }
    throw error;
  }

  const decisionEvent = decisionMetadata(
    decisionId, effectiveGeneration, identity, workflow, admission, reservationRank,
  );
  waitUntil(routingState.recordDecision(decisionEvent));

  const startedAt = Date.now();
  let finalized = false;
  const finalize = (result: {
    success: boolean; status: number; actualTokens?: number; timeToFirstTokenMs?: number;
    quotaSuccess: boolean; cooldown?: boolean; retryAfterMs?: number;
  }): void => {
    if (finalized) return;
    finalized = true;
    const completedAt = Date.now();
    const tasks: Promise<unknown>[] = [
      coordinator.recordOutcome(reservation.reservationId, {
        success: result.quotaSuccess,
        cooldown: result.cooldown,
        actualTokens: result.actualTokens,
        observation: result.cooldown ? { status: result.status, retryAfterMs: result.retryAfterMs } : undefined,
        settings: provider.rateLimits,
      }),
      routingState.recordCallOutcome(callOutcome(
        decisionId, identity, effectiveGeneration, provider.id, selection.model.id,
        startedAt, completedAt, result,
      )),
    ];
    if (callerAdmission && callerReservation) {
      tasks.push(callerAdmission.coordinator.recordOutcome(callerReservation.reservationId, {
        success: result.quotaSuccess,
        actualTokens: result.actualTokens,
        settings: callerAdmission.settings,
      }));
    }
    if (workflowCallId && workflowCoordinator) {
      tasks.push(workflowCoordinator.finishCall(workflowCallId, result.success, result.actualTokens));
    }
    waitUntil(Promise.all(tasks));
  };

  let upstream: Response;
  try {
    upstream = await provider.invoke(effectiveGeneration, selection.model);
  } catch {
    finalize({ success: false, status: 502, quotaSuccess: false, cooldown: true });
    throw new RouterError("upstream_error", `${provider.id} could not be reached.`, 502);
  }

  if (!upstream.ok) {
    const retryAfterMs = retryAfter(upstream);
    finalize({
      success: false, status: upstream.status, quotaSuccess: false,
      cooldown: upstream.status === 429 || upstream.status >= 500, retryAfterMs,
    });
    return passthrough(upstream, provider.id, selection.model.id, "upstream-error", policy.activePolicy);
  }

  if (effectiveGeneration.stream) {
    return observedStream(upstream, provider.id, selection.model.id, policy.activePolicy, startedAt, finalize);
  }
  const sanitized = await sanitizeCompletion(upstream, provider.id, selection.model.id, policy.activePolicy);
  finalize({ success: true, status: upstream.status, quotaSuccess: true, actualTokens: sanitized.actualTokens });
  return sanitized.response;
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
  routingState: DurableObjectStub<RoutingState>,
  identity: ExecutionIdentity,
  allowInlineWait: boolean,
): Promise<ReservedRuntime> {
  const inspected = await inspectCandidates(selections, providers, env);
  const available = inspected.filter((candidate) => candidate.quote.allowed);
  const policyCandidates = available.map(toPolicyCandidate);
  const contextKey = workflowContextKey(request);
  const planning = await routingState.getPlanningState({
    callerId: identity.callerId,
    environment: identity.environment,
    contextKey,
    candidates: policyCandidates.map((candidate) => ({
      providerId: candidate.providerId, modelId: candidate.selection.model.id,
    })),
  }, defaultPolicyControl(env));
  const policy = decidePolicy(request, policyCandidates, planning.statistics, {
    mode: planning.control.mode,
    explorationRate: planning.control.explorationRate,
    minObservations: planning.control.minObservations,
    random: secureRandom,
  });

  for (let index = 0; index < policy.ranked.length; index += 1) {
    const rankedCandidate = policy.ranked[index];
    const candidate = available.find((item) => sameCandidate(item, rankedCandidate));
    if (!candidate) continue;
    const reservation = await candidate.coordinator.reserve(candidate.selection.reservedTokens, candidate.provider.rateLimits);
    if (reservation.allowed && reservation.reservationId) {
      return {
        ...candidate,
        reservation: reservation as ReservedRuntime["reservation"],
        policy,
        reservationRank: index,
      };
    }
  }

  const retryAfterMs = earliestRetry(inspected);
  const inlineWait = allowInlineWait ? optionalPositiveNumber(env.MAX_INLINE_WAIT_MS) ?? 0 : 0;
  if (retryAfterMs !== undefined && retryAfterMs <= inlineWait) {
    await sleep(retryAfterMs);
    return admitRankedRoute(request, selections, providers, env, routingState, identity, false);
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
  return Promise.all(candidates.map(async (candidate) => ({
    ...candidate,
    quote: await candidate.coordinator.inspect(candidate.selection.reservedTokens, candidate.provider.rateLimits),
  })));
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

function observedStream(
  upstream: Response,
  provider: string,
  model: string,
  policy: string,
  startedAt: number,
  finalize: (result: { success: boolean; status: number; quotaSuccess: boolean; timeToFirstTokenMs?: number }) => void,
): Response {
  if (!upstream.body) {
    finalize({ success: true, status: upstream.status, quotaSuccess: true });
    return passthrough(upstream, provider, model, "policy-selected", policy);
  }
  const reader = upstream.body.getReader();
  let ttft: number | undefined;
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const chunk = await reader.read();
        if (chunk.done) {
          finalize({ success: true, status: upstream.status, quotaSuccess: true, timeToFirstTokenMs: ttft });
          controller.close();
          return;
        }
        ttft ??= Date.now() - startedAt;
        controller.enqueue(chunk.value);
      } catch (error) {
        finalize({ success: false, status: 502, quotaSuccess: true, timeToFirstTokenMs: ttft });
        controller.error(error);
      }
    },
    async cancel(reason) {
      await reader.cancel(reason);
      finalize({ success: false, status: 499, quotaSuccess: true, timeToFirstTokenMs: ttft });
    },
  });
  const headers = routedHeaders(upstream.headers, provider, model, "policy-selected", policy);
  return new Response(body, { status: upstream.status, statusText: upstream.statusText, headers });
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
  upstream: Response, provider: string, model: string, policy: string,
): Promise<{ response: Response; actualTokens?: number }> {
  const headers = routedHeaders(upstream.headers, provider, model, "policy-selected", policy);
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
    const usage = payload.usage && typeof payload.usage === "object" ? payload.usage as Record<string, unknown> : undefined;
    const actualTokens = typeof usage?.total_tokens === "number" ? Math.max(0, usage.total_tokens) : undefined;
    headers.set("content-type", "application/json");
    headers.delete("content-length");
    headers.delete("content-encoding");
    return {
      response: new Response(JSON.stringify(payload), { status: upstream.status, statusText: upstream.statusText, headers }),
      actualTokens,
    };
  } catch {
    return { response: passthrough(upstream, provider, model, "policy-selected", policy) };
  }
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
function secureRandom(): number {
  const value = new Uint32Array(1);
  crypto.getRandomValues(value);
  return value[0] / 0x1_0000_0000;
}
function hasLimits(settings: ProviderRateLimitSettings): boolean {
  return settings.dailySafetyBudgetTokens > 0 || Boolean(settings.requests || settings.tokens || settings.maxConcurrent);
}
