import { DurableObject } from "cloudflare:workers";
import type { Env } from "../../config";
import { decidePolicy, type PolicyDecision, type ProviderStatistics } from "../../core/adaptive-policy";
import type { AvailableCandidate } from "../../core/policy";
import type { GenerationRequest, ProviderRateLimitSettings, RouteSelection } from "../../core/types";
import type { CallOutcomeEvent, PolicyControl, WorkflowLearningOutcome } from "./routing-state";
import type { AdmissionQuote, AdmissionReason, UpstreamRateLimitObservation } from "./quota-coordinator";

export interface RoutingCandidateInput {
  selection: RouteSelection;
  providerId: string;
  credentialScope: string;
  rateLimits: ProviderRateLimitSettings;
  catalogOrder: number;
}

export interface RoutingPlanInput {
  request: Pick<GenerationRequest, "model" | "max_tokens" | "stream" | "tools" | "route">;
  callerId: string;
  environment: string;
  contextKey: string;
  candidates: RoutingCandidateInput[];
  excludedProviderKeys: string[];
  defaultControl: PolicyControl;
}

export interface RoutingReservation {
  providerId: string;
  credentialScope: string;
  modelId: string;
  reservationId: string;
  policy: PolicyDecision;
  reservationRank: number;
}

export interface RoutingPlanResult {
  allowed: boolean;
  reservation?: RoutingReservation;
  retryAfterMs?: number;
  reason?: AdmissionReason;
}

export interface ProviderOutcome {
  quotaSuccess: boolean;
  cooldown?: boolean;
  actualTokens?: number;
  observation?: UpstreamRateLimitObservation;
  settings: ProviderRateLimitSettings;
  learning?: CallOutcomeEvent;
}

interface QuotedCandidate extends AvailableCandidate {
  rateLimits: ProviderRateLimitSettings;
  quote: AdmissionQuote;
}

interface StatisticRow {
  [key: string]: SqlStorageValue;
  scope_key: string;
  provider_id: string;
  model_id: string;
  observations: number;
  success_alpha: number;
  success_beta: number;
  completion_alpha: number;
  completion_beta: number;
  rate_alpha: number;
  rate_beta: number;
  quality_mean: number;
  quality_count: number;
  latency_ewma_ms: number | null;
  tokens_ewma: number | null;
}

/**
 * One coordinator per routing environment/credential pool. It owns the safety-critical provider
 * counters and the small online-policy state so admission, ranking, and reservation need one RPC.
 * Prompts, completions, provider keys, and upstream network calls never enter this object.
 */
export class RoutingCoordinator extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      ctx.storage.sql.exec(`
        CREATE TABLE IF NOT EXISTS quota_state (
          scope_key TEXT NOT NULL, key TEXT NOT NULL, value INTEGER NOT NULL,
          PRIMARY KEY(scope_key, key)
        );
        CREATE TABLE IF NOT EXISTS reservations (
          scope_key TEXT NOT NULL, id TEXT NOT NULL, tokens INTEGER NOT NULL, created_at INTEGER NOT NULL,
          PRIMARY KEY(scope_key, id)
        );
        CREATE INDEX IF NOT EXISTS reservations_scope_created
          ON reservations(scope_key, created_at);
        CREATE TABLE IF NOT EXISTS policy_stats (
          scope_key TEXT NOT NULL, provider_id TEXT NOT NULL, model_id TEXT NOT NULL,
          observations INTEGER NOT NULL DEFAULT 0,
          success_alpha REAL NOT NULL DEFAULT 1, success_beta REAL NOT NULL DEFAULT 1,
          completion_alpha REAL NOT NULL DEFAULT 1, completion_beta REAL NOT NULL DEFAULT 1,
          rate_alpha REAL NOT NULL DEFAULT 1, rate_beta REAL NOT NULL DEFAULT 9,
          quality_mean REAL NOT NULL DEFAULT 0.5, quality_count INTEGER NOT NULL DEFAULT 0,
          latency_ewma_ms REAL, tokens_ewma REAL,
          PRIMARY KEY(scope_key, provider_id, model_id)
        );
        CREATE TABLE IF NOT EXISTS policy_control (
          environment TEXT PRIMARY KEY, mode TEXT NOT NULL, exploration_rate REAL NOT NULL,
          min_observations INTEGER NOT NULL, updated_at INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS learned_call_outcomes (
          decision_id TEXT PRIMARY KEY, completed_at INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS learned_workflow_outcomes (
          workflow_id TEXT PRIMARY KEY, completed_at INTEGER NOT NULL
        );
      `);
    });
  }

  async planAndReserve(input: RoutingPlanInput): Promise<RoutingPlanResult> {
    return this.ctx.storage.transactionSync(() => {
      const excluded = new Set(input.excludedProviderKeys);
      const now = Date.now();
      const inspected = input.candidates
        .filter((candidate) => !excluded.has(providerKey(candidate.providerId, candidate.credentialScope)))
        .map((candidate): QuotedCandidate => {
          const scope = providerKey(candidate.providerId, candidate.credentialScope);
          const quote = this.inspect(scope, candidate.selection.reservedTokens, candidate.rateLimits, now);
          return {
            selection: candidate.selection,
            providerId: candidate.providerId,
            credentialScope: candidate.credentialScope,
            rateLimits: candidate.rateLimits,
            catalogOrder: candidate.catalogOrder,
            availability: quote.snapshot,
            quote,
          };
        });
      if (inspected.length === 0) return { allowed: false };

      const available = inspected.filter((candidate) => candidate.quote.allowed);
      if (available.length === 0) return earliestDenial(inspected);

      const statistics = available.map((candidate) => this.hierarchicalStatistic(input, candidate));
      const control = this.getPolicyControl(input.environment, input.defaultControl);
      const policy = decidePolicy(
        { messages: [], ...input.request },
        available,
        statistics,
        { ...control, random: secureRandom },
      );

      for (let index = 0; index < policy.ranked.length; index += 1) {
        const ranked = policy.ranked[index];
        const candidate = available.find((item) => sameCandidate(item, ranked));
        if (!candidate) continue;
        const scope = providerKey(candidate.providerId, candidate.credentialScope);
        const reservation = this.reserve(scope, candidate.selection.reservedTokens, candidate.rateLimits, now);
        if (reservation.allowed && reservation.reservationId) {
          return {
            allowed: true,
            reservation: {
              providerId: candidate.providerId,
              credentialScope: candidate.credentialScope,
              modelId: candidate.selection.model.id,
              reservationId: reservation.reservationId,
              policy,
              reservationRank: index,
            },
          };
        }
      }
      return earliestDenial(inspected);
    });
  }

  async recordProviderOutcome(scope: string, reservationId: string, outcome: ProviderOutcome): Promise<void> {
    this.ctx.storage.transactionSync(() => {
      const row = [...this.ctx.storage.sql.exec<{ tokens: number }>(
        "SELECT tokens FROM reservations WHERE scope_key = ? AND id = ?", scope, reservationId,
      )][0];
      if (row) {
        const now = Date.now();
        this.ctx.storage.sql.exec("DELETE FROM reservations WHERE scope_key = ? AND id = ?", scope, reservationId);
        if (outcome.quotaSuccess) {
          const key = `spent_${utcDay(now)}`;
          this.write(scope, key, this.read(scope, key) + Math.max(0, outcome.actualTokens ?? row.tokens));
        } else if (outcome.cooldown) {
          const retryAfterMs = outcome.observation?.retryAfterMs ?? outcome.settings.cooldownMs;
          this.write(scope, "cooldown_until", Math.max(this.read(scope, "cooldown_until"), now + retryAfterMs));
        }
      }
      if (outcome.learning) this.recordLearningOutcome(outcome.learning);
    });
  }

  async recordWorkflowLearning(event: WorkflowLearningOutcome): Promise<void> {
    this.ctx.storage.transactionSync(() => {
      if (!event.providerId || !event.modelId) return;
      const inserted = this.ctx.storage.sql.exec(
        "INSERT OR IGNORE INTO learned_workflow_outcomes (workflow_id, completed_at) VALUES (?, ?)",
        event.workflowId, event.completedAt,
      );
      if (inserted.rowsWritten === 0) return;
      for (const scope of statisticScopes(event.environment, event.callerId, event.contextKey)) {
        this.ctx.storage.sql.exec(
          `INSERT INTO policy_stats
           (scope_key, provider_id, model_id, completion_alpha, completion_beta, quality_mean, quality_count)
           VALUES (?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(scope_key, provider_id, model_id) DO UPDATE SET
             completion_alpha = completion_alpha + ?, completion_beta = completion_beta + ?,
             quality_mean = CASE WHEN excluded.quality_count = 0 THEN quality_mean
               ELSE (quality_mean * quality_count + excluded.quality_mean) / (quality_count + 1) END,
             quality_count = quality_count + excluded.quality_count`,
          scope, event.providerId, event.modelId,
          event.success ? 2 : 1, event.success ? 1 : 2,
          event.quality ?? 0.5, event.quality === undefined ? 0 : 1,
          event.success ? 1 : 0, event.success ? 0 : 1,
        );
      }
    });
  }

  async setPolicyControl(environment: string, control: PolicyControl): Promise<PolicyControl> {
    const normalized = normalizeControl(control);
    const updatedAt = Date.now();
    this.ctx.storage.sql.exec(
      `INSERT INTO policy_control (environment, mode, exploration_rate, min_observations, updated_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(environment) DO UPDATE SET mode = excluded.mode,
         exploration_rate = excluded.exploration_rate, min_observations = excluded.min_observations,
         updated_at = excluded.updated_at`,
      environment, normalized.mode, normalized.explorationRate, normalized.minObservations, updatedAt,
    );
    return { ...normalized, updatedAt };
  }

  async policyControl(environment: string, defaults: PolicyControl): Promise<PolicyControl> {
    return this.getPolicyControl(environment, defaults);
  }

  private inspect(scope: string, tokens: number, settings: ProviderRateLimitSettings, now: number): AdmissionQuote {
    this.releaseExpiredReservations(scope, now, settings.reservationTtlMs);
    const snapshot = this.snapshot(scope, now, settings);
    const cooldownUntil = this.read(scope, "cooldown_until");
    if (cooldownUntil > now) return { ...denied("cooldown", cooldownUntil - now), snapshot };
    const spent = this.read(scope, `spent_${utcDay(now)}`);
    const reservedToday = this.reservedTokensForDay(scope, now);
    if (settings.dailySafetyBudgetTokens > 0 && spent + reservedToday + tokens > settings.dailySafetyBudgetTokens) {
      return { ...denied("safety_budget", msUntilNextUtcDay(now)), snapshot };
    }
    const requestDecision = this.checkBucket(scope, "requests", 1, settings.requests, now);
    if (requestDecision) return { ...requestDecision, snapshot };
    const tokenDecision = this.checkBucket(scope, "tokens", tokens, settings.tokens, now);
    if (tokenDecision) return { ...tokenDecision, snapshot };
    if (settings.maxConcurrent && this.reservationCount(scope) >= settings.maxConcurrent) {
      return { ...denied("concurrency_limit", this.retryAfterForConcurrency(scope, now, settings.reservationTtlMs)), snapshot };
    }
    return { allowed: true, snapshot };
  }

  private reserve(
    scope: string, tokens: number, settings: ProviderRateLimitSettings, now: number,
  ): { allowed: boolean; reservationId?: string; retryAfterMs?: number; reason?: AdmissionReason } {
    const quote = this.inspect(scope, tokens, settings, now);
    if (!quote.allowed) return quote;
    const id = crypto.randomUUID();
    this.ctx.storage.sql.exec(
      "INSERT INTO reservations (scope_key, id, tokens, created_at) VALUES (?, ?, ?, ?)",
      scope, id, tokens, now,
    );
    this.spendBucket(scope, "requests", 1, settings.requests, now);
    this.spendBucket(scope, "tokens", tokens, settings.tokens, now);
    return { allowed: true, reservationId: id };
  }

  private checkBucket(
    scope: string, name: "requests" | "tokens", amount: number,
    limit: ProviderRateLimitSettings["requests"], now: number,
  ): { allowed: false; retryAfterMs: number; reason: AdmissionReason } | undefined {
    if (!limit || limit.limit <= 0 || limit.windowMs <= 0) return undefined;
    const available = this.refilledBucket(scope, name, limit, now);
    const required = amount * 1_000;
    if (available >= required) return undefined;
    const refillPerMs = (limit.limit * 1_000) / limit.windowMs;
    return denied(name === "requests" ? "request_rate_limit" : "token_rate_limit", Math.ceil((required - available) / refillPerMs));
  }

  private spendBucket(
    scope: string, name: "requests" | "tokens", amount: number,
    limit: ProviderRateLimitSettings["requests"], now: number,
  ): void {
    if (!limit || limit.limit <= 0 || limit.windowMs <= 0) return;
    const available = this.refilledBucket(scope, name, limit, now);
    this.write(scope, `${name}_available`, Math.max(0, available - amount * 1_000));
    this.write(scope, `${name}_refilled_at`, now);
  }

  private refilledBucket(
    scope: string, name: "requests" | "tokens",
    limit: NonNullable<ProviderRateLimitSettings["requests"]>, now: number,
  ): number {
    const capacity = limit.limit * 1_000;
    const prior = this.readOptional(scope, `${name}_available`) ?? capacity;
    const refilledAt = this.readOptional(scope, `${name}_refilled_at`) ?? now;
    return Math.min(capacity, prior + Math.floor((Math.max(0, now - refilledAt) * capacity) / limit.windowMs));
  }

  private snapshot(scope: string, now: number, settings: ProviderRateLimitSettings): AdmissionQuote["snapshot"] {
    const reservations = this.reservationCount(scope);
    const spent = this.read(scope, `spent_${utcDay(now)}`) + this.reservedTokensForDay(scope, now);
    return {
      requestCapacity: settings.requests ? Math.floor(this.refilledBucket(scope, "requests", settings.requests, now) / 1_000) : undefined,
      tokenCapacity: settings.tokens ? Math.floor(this.refilledBucket(scope, "tokens", settings.tokens, now) / 1_000) : undefined,
      concurrentAvailable: settings.maxConcurrent ? Math.max(0, settings.maxConcurrent - reservations) : undefined,
      dailyTokensRemaining: settings.dailySafetyBudgetTokens > 0 ? Math.max(0, settings.dailySafetyBudgetTokens - spent) : undefined,
    };
  }

  private releaseExpiredReservations(scope: string, now: number, ttlMs: number): void {
    this.ctx.storage.sql.exec(
      "DELETE FROM reservations WHERE scope_key = ? AND created_at < ?", scope, now - ttlMs,
    );
  }

  private reservationCount(scope: string): number {
    return [...this.ctx.storage.sql.exec<{ count: number }>(
      "SELECT COUNT(*) AS count FROM reservations WHERE scope_key = ?", scope,
    )][0]?.count ?? 0;
  }

  private reservedTokensForDay(scope: string, now: number): number {
    const start = Date.parse(`${utcDay(now)}T00:00:00.000Z`);
    return [...this.ctx.storage.sql.exec<{ total: number }>(
      "SELECT COALESCE(SUM(tokens), 0) AS total FROM reservations WHERE scope_key = ? AND created_at >= ?", scope, start,
    )][0]?.total ?? 0;
  }

  private retryAfterForConcurrency(scope: string, now: number, ttlMs: number): number {
    const row = [...this.ctx.storage.sql.exec<{ created_at: number }>(
      "SELECT MIN(created_at) AS created_at FROM reservations WHERE scope_key = ?", scope,
    )][0];
    return row?.created_at ? Math.max(1, row.created_at + ttlMs - now) : ttlMs;
  }

  private read(scope: string, key: string): number { return this.readOptional(scope, key) ?? 0; }

  private readOptional(scope: string, key: string): number | undefined {
    return [...this.ctx.storage.sql.exec<{ value: number }>(
      "SELECT value FROM quota_state WHERE scope_key = ? AND key = ?", scope, key,
    )][0]?.value;
  }

  private write(scope: string, key: string, value: number): void {
    this.ctx.storage.sql.exec(
      `INSERT INTO quota_state (scope_key, key, value) VALUES (?, ?, ?)
       ON CONFLICT(scope_key, key) DO UPDATE SET value = excluded.value`,
      scope, key, value,
    );
  }

  private recordLearningOutcome(event: CallOutcomeEvent): void {
    const inserted = this.ctx.storage.sql.exec(
      "INSERT OR IGNORE INTO learned_call_outcomes (decision_id, completed_at) VALUES (?, ?)",
      event.decisionId, event.completedAt,
    );
    if (inserted.rowsWritten === 0) return;
    for (const scope of statisticScopes(event.environment, event.callerId, event.contextKey)) {
      this.ctx.storage.sql.exec(
        `INSERT INTO policy_stats
         (scope_key, provider_id, model_id, observations, success_alpha, success_beta,
          rate_alpha, rate_beta, latency_ewma_ms, tokens_ewma)
         VALUES (?, ?, ?, 1, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(scope_key, provider_id, model_id) DO UPDATE SET
           observations = observations + 1,
           success_alpha = success_alpha + ?, success_beta = success_beta + ?,
           rate_alpha = rate_alpha + ?, rate_beta = rate_beta + ?,
           latency_ewma_ms = CASE WHEN latency_ewma_ms IS NULL THEN excluded.latency_ewma_ms
                                 ELSE latency_ewma_ms * 0.8 + excluded.latency_ewma_ms * 0.2 END,
           tokens_ewma = CASE WHEN excluded.tokens_ewma IS NULL THEN tokens_ewma
                              WHEN tokens_ewma IS NULL THEN excluded.tokens_ewma
                              ELSE tokens_ewma * 0.8 + excluded.tokens_ewma * 0.2 END`,
        scope, event.providerId, event.modelId,
        event.success ? 2 : 1, event.success ? 1 : 2,
        event.rateLimited ? 2 : 1, event.rateLimited ? 9 : 10,
        event.latencyMs, event.actualTokens ?? null,
        event.success ? 1 : 0, event.success ? 0 : 1,
        event.rateLimited ? 1 : 0, event.rateLimited ? 0 : 1,
      );
    }
  }

  private getPolicyControl(environment: string, defaults: PolicyControl): PolicyControl {
    const row = [...this.ctx.storage.sql.exec<{
      mode: PolicyControl["mode"]; exploration_rate: number; min_observations: number; updated_at: number;
    }>("SELECT * FROM policy_control WHERE environment = ?", environment)][0];
    return row ? {
      mode: row.mode,
      explorationRate: row.exploration_rate,
      minObservations: row.min_observations,
      updatedAt: row.updated_at,
    } : normalizeControl(defaults);
  }

  private hierarchicalStatistic(
    query: Pick<RoutingPlanInput, "environment" | "callerId" | "contextKey">,
    candidate: { providerId: string; selection: RouteSelection },
  ): ProviderStatistics {
    const lookup = { providerId: candidate.providerId, modelId: candidate.selection.model.id };
    const global = this.readStatistic(globalScope(query.environment), lookup);
    const context = this.readStatistic(contextScope(query.environment, query.contextKey), lookup);
    const caller = this.readStatistic(callerScope(query.environment, query.callerId, query.contextKey), lookup);
    const globalSuccess = mean(global?.success_alpha, global?.success_beta, 0.5);
    const contextSuccess = mean(context?.success_alpha, context?.success_beta, globalSuccess);
    const globalCompletion = mean(global?.completion_alpha, global?.completion_beta, 0.5);
    const contextCompletion = mean(context?.completion_alpha, context?.completion_beta, globalCompletion);
    const globalRate = mean(global?.rate_alpha, global?.rate_beta, 0.1);
    const contextRate = mean(context?.rate_alpha, context?.rate_beta, globalRate);
    const strength = 12;
    return {
      ...lookup,
      observations: Math.max(global?.observations ?? 0, context?.observations ?? 0, caller?.observations ?? 0),
      successAlpha: Math.max(0, (caller?.success_alpha ?? 1) - 1) + contextSuccess * strength,
      successBeta: Math.max(0, (caller?.success_beta ?? 1) - 1) + (1 - contextSuccess) * strength,
      completionAlpha: Math.max(0, (caller?.completion_alpha ?? 1) - 1) + contextCompletion * strength,
      completionBeta: Math.max(0, (caller?.completion_beta ?? 1) - 1) + (1 - contextCompletion) * strength,
      rateLimitAlpha: Math.max(0, (caller?.rate_alpha ?? 1) - 1) + contextRate * strength,
      rateLimitBeta: Math.max(0, (caller?.rate_beta ?? 9) - 9) + (1 - contextRate) * strength,
      qualityMean: caller?.quality_count ? caller.quality_mean : context?.quality_count ? context.quality_mean : global?.quality_mean ?? 0.5,
      qualityCount: Math.max(global?.quality_count ?? 0, context?.quality_count ?? 0, caller?.quality_count ?? 0),
      latencyEwmaMs: caller?.latency_ewma_ms ?? context?.latency_ewma_ms ?? global?.latency_ewma_ms ?? undefined,
      tokensEwma: caller?.tokens_ewma ?? context?.tokens_ewma ?? global?.tokens_ewma ?? undefined,
    };
  }

  private readStatistic(scope: string, candidate: { providerId: string; modelId: string }): StatisticRow | undefined {
    return [...this.ctx.storage.sql.exec<StatisticRow>(
      "SELECT * FROM policy_stats WHERE scope_key = ? AND provider_id = ? AND model_id = ?",
      scope, candidate.providerId, candidate.modelId,
    )][0];
  }
}

function providerKey(providerId: string, credentialScope: string): string { return `${providerId}:${credentialScope}`; }
function globalScope(environment: string): string { return `global:${environment}`; }
function contextScope(environment: string, contextKey: string): string { return `context:${environment}:${contextKey}`; }
function callerScope(environment: string, callerId: string, contextKey: string): string { return `caller:${environment}:${callerId}:${contextKey}`; }
function statisticScopes(environment: string, callerId: string, contextKey: string): string[] {
  return [globalScope(environment), contextScope(environment, contextKey), callerScope(environment, callerId, contextKey)];
}

function sameCandidate(left: QuotedCandidate, right: AvailableCandidate): boolean {
  return left.providerId === right.providerId
    && left.credentialScope === right.credentialScope
    && left.selection.model.id === right.selection.model.id;
}

function earliestDenial(candidates: QuotedCandidate[]): RoutingPlanResult {
  const deniedCandidates = candidates.filter((candidate) => !candidate.quote.allowed);
  const earliest = deniedCandidates
    .filter((candidate) => typeof candidate.quote.retryAfterMs === "number")
    .sort((left, right) => (left.quote.retryAfterMs ?? Infinity) - (right.quote.retryAfterMs ?? Infinity))[0];
  return {
    allowed: false,
    retryAfterMs: earliest?.quote.retryAfterMs,
    reason: earliest?.quote.reason,
  };
}

function denied(reason: AdmissionReason, retryAfterMs: number): { allowed: false; reason: AdmissionReason; retryAfterMs: number } {
  return { allowed: false, reason, retryAfterMs: Math.max(1, retryAfterMs) };
}

function normalizeControl(control: PolicyControl): PolicyControl {
  return {
    mode: control.mode === "adaptive" || control.mode === "shadow" ? control.mode : "baseline",
    explorationRate: Math.max(0, Math.min(0.25, Number.isFinite(control.explorationRate) ? control.explorationRate : 0)),
    minObservations: Math.max(0, Math.min(1_000_000, Number.isFinite(control.minObservations) ? Math.floor(control.minObservations) : 0)),
  };
}

function mean(alpha: number | undefined, beta: number | undefined, fallback: number): number {
  return alpha !== undefined && beta !== undefined && alpha + beta > 0 ? alpha / (alpha + beta) : fallback;
}

function secureRandom(): number {
  const value = new Uint32Array(1);
  crypto.getRandomValues(value);
  return value[0] / 0x1_0000_0000;
}

function utcDay(timestamp: number): string { return new Date(timestamp).toISOString().slice(0, 10); }
function msUntilNextUtcDay(timestamp: number): number {
  const next = new Date(timestamp);
  next.setUTCHours(24, 0, 0, 0);
  return next.getTime() - timestamp;
}
