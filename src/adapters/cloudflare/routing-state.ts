import { DurableObject } from "cloudflare:workers";
import type { Env } from "../../config";
import type { ProviderStatistics } from "../../core/adaptive-policy";
import { evaluateOffPolicy } from "../../core/evaluation";

export interface DecisionCandidateEvent {
  providerId: string;
  modelId: string;
  reservedTokens: number;
  requestCapacity?: number;
  tokenCapacity?: number;
  concurrentAvailable?: number;
  dailyTokensRemaining?: number;
  baselineScore: number;
  learnedScore: number;
}

/** Deliberately metadata-only. There is no field capable of holding messages or completions. */
export interface RoutingDecisionEvent {
  id: string;
  createdAt: number;
  callerId: string;
  environment: string;
  contextKey: string;
  workflowId?: string;
  selectedProvider: string;
  selectedModel: string;
  reservationRank: number;
  activePolicy: string;
  policyVersion: string;
  baselineWinner?: string;
  shadowWinner?: string;
  propensity: number;
  explored: boolean;
  features: {
    workflowType: string;
    qualityTier: string;
    expectedCalls: number;
    maxConcurrency: number;
    estimatedTotalTokens: number;
    requestedOutputTokens: number;
    streaming: boolean;
    tools: boolean;
  };
  candidates: DecisionCandidateEvent[];
}

export interface CallOutcomeEvent {
  decisionId: string;
  completedAt: number;
  callerId: string;
  environment: string;
  contextKey: string;
  workflowId?: string;
  providerId: string;
  modelId: string;
  success: boolean;
  status: number;
  rateLimited: boolean;
  latencyMs: number;
  timeToFirstTokenMs?: number;
  actualTokens?: number;
}

export interface WorkflowLearningOutcome {
  workflowId: string;
  completedAt: number;
  callerId: string;
  environment: string;
  contextKey: string;
  providerId?: string;
  modelId?: string;
  success: boolean;
  quality?: number;
  validatorPassed?: boolean;
  deadlineMet?: boolean;
  callsCompleted: number;
  actualTokens: number;
}

export interface StatisticsQuery {
  callerId: string;
  environment: string;
  contextKey: string;
  candidates: Array<{ providerId: string; modelId: string }>;
}

export interface PolicyControl {
  mode: "baseline" | "shadow" | "adaptive";
  explorationRate: number;
  minObservations: number;
  updatedAt?: number;
}

export interface WorkflowForecast {
  observations: number;
  expectedCalls: number;
  maxCalls: number;
  estimatedTotalTokens: number;
  completionProbability: number;
  callDistribution: "poisson" | "negative-binomial";
  callStdDev: number;
  tokenStdDev: number;
}

/** Append-only routing telemetry plus compact online posterior state. */
export class RoutingState extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS routing_decisions (
        id TEXT PRIMARY KEY, created_at INTEGER NOT NULL, caller_id TEXT NOT NULL,
        environment TEXT NOT NULL, context_key TEXT NOT NULL, workflow_id TEXT,
        selected_provider TEXT NOT NULL, selected_model TEXT NOT NULL,
        reservation_rank INTEGER NOT NULL, active_policy TEXT NOT NULL, policy_version TEXT NOT NULL,
        baseline_winner TEXT, shadow_winner TEXT, propensity REAL NOT NULL, explored INTEGER NOT NULL,
        features_json TEXT NOT NULL, candidates_json TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS call_outcomes (
        decision_id TEXT PRIMARY KEY, completed_at INTEGER NOT NULL, caller_id TEXT NOT NULL,
        environment TEXT NOT NULL, context_key TEXT NOT NULL, workflow_id TEXT,
        provider_id TEXT NOT NULL, model_id TEXT NOT NULL, success INTEGER NOT NULL,
        status INTEGER NOT NULL, rate_limited INTEGER NOT NULL, latency_ms REAL NOT NULL,
        ttft_ms REAL, actual_tokens INTEGER
      );
      CREATE TABLE IF NOT EXISTS workflow_outcomes (
        workflow_id TEXT PRIMARY KEY, completed_at INTEGER NOT NULL, caller_id TEXT NOT NULL,
        environment TEXT NOT NULL, context_key TEXT NOT NULL, provider_id TEXT, model_id TEXT,
        success INTEGER NOT NULL, quality REAL, validator_passed INTEGER, deadline_met INTEGER,
        calls_completed INTEGER NOT NULL, actual_tokens INTEGER NOT NULL
      );
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
      CREATE TABLE IF NOT EXISTS workflow_forecasts (
        scope_key TEXT NOT NULL, workflow_type TEXT NOT NULL, observations INTEGER NOT NULL DEFAULT 0,
        completion_alpha REAL NOT NULL DEFAULT 1, completion_beta REAL NOT NULL DEFAULT 1,
        calls_mean REAL NOT NULL DEFAULT 0, calls_m2 REAL NOT NULL DEFAULT 0,
        tokens_mean REAL NOT NULL DEFAULT 0, tokens_m2 REAL NOT NULL DEFAULT 0,
        PRIMARY KEY(scope_key, workflow_type)
      );
      CREATE INDEX IF NOT EXISTS decisions_created_at ON routing_decisions(created_at);
      CREATE INDEX IF NOT EXISTS outcomes_completed_at ON call_outcomes(completed_at);
      `);
      const policyColumns = [...ctx.storage.sql.exec<{ name: string }>("PRAGMA table_info(policy_stats)")];
      if (!policyColumns.some((column) => column.name === "completion_alpha")) {
        ctx.storage.sql.exec("ALTER TABLE policy_stats ADD COLUMN completion_alpha REAL NOT NULL DEFAULT 1");
      }
      if (!policyColumns.some((column) => column.name === "completion_beta")) {
        ctx.storage.sql.exec("ALTER TABLE policy_stats ADD COLUMN completion_beta REAL NOT NULL DEFAULT 1");
      }
    });
  }

  async getStatistics(query: StatisticsQuery): Promise<ProviderStatistics[]> {
    return query.candidates.map((candidate) => this.hierarchicalStatistic(query, candidate));
  }

  async getPlanningState(
    query: StatisticsQuery, defaults: PolicyControl,
  ): Promise<{ statistics: ProviderStatistics[]; control: PolicyControl }> {
    return { statistics: await this.getStatistics(query), control: this.getPolicyControl(query.environment, defaults) };
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

  async workflowForecast(environment: string, callerId: string, workflowType: string): Promise<WorkflowForecast> {
    const global = this.readForecast(globalScope(environment), workflowType);
    const caller = this.readForecast(`workflow-caller:${environment}:${callerId}`, workflowType);
    const globalObservations = global?.observations ?? 0;
    const callerObservations = caller?.observations ?? 0;
    const shrinkage = 10;
    const callsMean = callerObservations > 0
      ? ((caller?.calls_mean ?? 0) * callerObservations + (global?.calls_mean ?? 1) * shrinkage) / (callerObservations + shrinkage)
      : global?.calls_mean ?? 1;
    const tokensMean = callerObservations > 0
      ? ((caller?.tokens_mean ?? 0) * callerObservations + (global?.tokens_mean ?? 1_024) * shrinkage) / (callerObservations + shrinkage)
      : global?.tokens_mean ?? 1_024;
    const callVariance = variance(caller ?? global, "calls");
    const tokenVariance = variance(caller ?? global, "tokens");
    const callStdDev = Math.sqrt(Math.max(callsMean, callVariance));
    const tokenStdDev = Math.sqrt(Math.max(0, tokenVariance));
    const completionAlpha = (caller?.completion_alpha ?? 1) + mean(global?.completion_alpha, global?.completion_beta, 0.5) * shrinkage;
    const completionBeta = (caller?.completion_beta ?? 1) + (1 - mean(global?.completion_alpha, global?.completion_beta, 0.5)) * shrinkage;
    return {
      observations: Math.max(globalObservations, callerObservations),
      expectedCalls: Math.max(1, Math.ceil(callsMean + 1.282 * callStdDev)),
      maxCalls: Math.max(1, Math.ceil(callsMean + 2 * callStdDev)),
      estimatedTotalTokens: Math.max(1, Math.ceil(tokensMean + 1.282 * tokenStdDev)),
      completionProbability: completionAlpha / (completionAlpha + completionBeta),
      callDistribution: callVariance > callsMean ? "negative-binomial" : "poisson",
      callStdDev,
      tokenStdDev,
    };
  }

  async recordDecision(event: RoutingDecisionEvent): Promise<void> {
    this.purgeExpired();
    this.ctx.storage.sql.exec(
      `INSERT OR IGNORE INTO routing_decisions
       (id, created_at, caller_id, environment, context_key, workflow_id, selected_provider,
        selected_model, reservation_rank, active_policy, policy_version, baseline_winner,
        shadow_winner, propensity, explored, features_json, candidates_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      event.id, event.createdAt, event.callerId, event.environment, event.contextKey,
      event.workflowId ?? null, event.selectedProvider, event.selectedModel, event.reservationRank,
      event.activePolicy, event.policyVersion, event.baselineWinner ?? null, event.shadowWinner ?? null,
      event.propensity, event.explored ? 1 : 0, JSON.stringify(event.features), JSON.stringify(event.candidates),
    );
  }

  async recordCallOutcome(event: CallOutcomeEvent): Promise<void> {
    this.purgeExpired();
    const inserted = this.ctx.storage.sql.exec(
      `INSERT OR IGNORE INTO call_outcomes
       (decision_id, completed_at, caller_id, environment, context_key, workflow_id, provider_id,
        model_id, success, status, rate_limited, latency_ms, ttft_ms, actual_tokens)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      event.decisionId, event.completedAt, event.callerId, event.environment, event.contextKey,
      event.workflowId ?? null, event.providerId, event.modelId, event.success ? 1 : 0,
      event.status, event.rateLimited ? 1 : 0, event.latencyMs,
      event.timeToFirstTokenMs ?? null, event.actualTokens ?? null,
    );
    if (inserted.rowsWritten === 0) return;
    for (const scope of scopes(event.environment, event.callerId, event.contextKey)) {
      this.updateCallStatistic(scope, event);
    }
  }

  async recordWorkflowOutcome(event: WorkflowLearningOutcome): Promise<void> {
    this.purgeExpired();
    const inserted = this.ctx.storage.sql.exec(
      `INSERT OR IGNORE INTO workflow_outcomes
       (workflow_id, completed_at, caller_id, environment, context_key, provider_id, model_id,
        success, quality, validator_passed, deadline_met, calls_completed, actual_tokens)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      event.workflowId, event.completedAt, event.callerId, event.environment, event.contextKey,
      event.providerId ?? null, event.modelId ?? null, event.success ? 1 : 0, event.quality ?? null,
      booleanSql(event.validatorPassed), booleanSql(event.deadlineMet), event.callsCompleted, event.actualTokens,
    );
    if (inserted.rowsWritten === 0) return;
    const workflowType = event.contextKey.split(":", 1)[0] || "single-turn";
    this.updateWorkflowForecast(globalScope(event.environment), workflowType, event);
    this.updateWorkflowForecast(`workflow-caller:${event.environment}:${event.callerId}`, workflowType, event);
    if (!event.providerId || !event.modelId) return;
    for (const scope of scopes(event.environment, event.callerId, event.contextKey)) {
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
  }

  async summary(environment: string): Promise<Record<string, unknown>> {
    const decisions = scalar(this.ctx.storage.sql.exec<{ count: number }>(
      "SELECT COUNT(*) AS count FROM routing_decisions WHERE environment = ?", environment,
    ));
    const outcomes = scalar(this.ctx.storage.sql.exec<{ count: number }>(
      "SELECT COUNT(*) AS count FROM call_outcomes WHERE environment = ?", environment,
    ));
    const workflows = scalar(this.ctx.storage.sql.exec<{ count: number }>(
      "SELECT COUNT(*) AS count FROM workflow_outcomes WHERE environment = ?", environment,
    ));
    const providers = [...this.ctx.storage.sql.exec<Record<string, SqlStorageValue>>(
      `SELECT provider_id, model_id, observations, success_alpha, success_beta, completion_alpha, completion_beta,
              rate_alpha, rate_beta, quality_mean, quality_count, latency_ewma_ms, tokens_ewma
       FROM policy_stats WHERE scope_key = ? ORDER BY provider_id, model_id`,
      globalScope(environment),
    )];
    return { environment, decisions, outcomes, workflows, providers };
  }

  async shadowEvaluation(environment: string): Promise<Record<string, unknown>> {
    const rows = [...this.ctx.storage.sql.exec<{
      success: number; propensity: number; shadow_winner: string;
      selected_provider: string; selected_model: string;
    }>(
      `SELECT o.success, d.propensity, d.shadow_winner, d.selected_provider, d.selected_model
       FROM routing_decisions d JOIN call_outcomes o ON o.decision_id = d.id
       WHERE d.environment = ? AND d.shadow_winner IS NOT NULL AND d.propensity > 0`,
      environment,
    )];
    const estimate = evaluateOffPolicy(rows.map((row) => ({
      reward: row.success,
      loggedPropensity: row.propensity,
      targetPropensity: row.shadow_winner === `${row.selected_provider}:${row.selected_model}` ? 1 : 0,
    })));
    return {
      environment,
      metric: "call_success_proxy",
      ...estimate,
      warning: "Activate only after effective sample size and workflow-level evaluation are sufficient.",
    };
  }

  private updateCallStatistic(scope: string, event: CallOutcomeEvent): void {
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

  private updateWorkflowForecast(
    scope: string, workflowType: string, event: WorkflowLearningOutcome,
  ): void {
    const prior = this.readForecast(scope, workflowType);
    const count = prior?.observations ?? 0;
    const nextCount = count + 1;
    const callsDelta = event.callsCompleted - (prior?.calls_mean ?? 0);
    const callsMean = (prior?.calls_mean ?? 0) + callsDelta / nextCount;
    const callsM2 = (prior?.calls_m2 ?? 0) + callsDelta * (event.callsCompleted - callsMean);
    const tokensDelta = event.actualTokens - (prior?.tokens_mean ?? 0);
    const tokensMean = (prior?.tokens_mean ?? 0) + tokensDelta / nextCount;
    const tokensM2 = (prior?.tokens_m2 ?? 0) + tokensDelta * (event.actualTokens - tokensMean);
    this.ctx.storage.sql.exec(
      `INSERT INTO workflow_forecasts
       (scope_key, workflow_type, observations, completion_alpha, completion_beta,
        calls_mean, calls_m2, tokens_mean, tokens_m2)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(scope_key, workflow_type) DO UPDATE SET observations = excluded.observations,
         completion_alpha = excluded.completion_alpha, completion_beta = excluded.completion_beta,
         calls_mean = excluded.calls_mean, calls_m2 = excluded.calls_m2,
         tokens_mean = excluded.tokens_mean, tokens_m2 = excluded.tokens_m2`,
      scope, workflowType, nextCount,
      (prior?.completion_alpha ?? 1) + (event.success ? 1 : 0),
      (prior?.completion_beta ?? 1) + (event.success ? 0 : 1),
      callsMean, callsM2, tokensMean, tokensM2,
    );
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
    query: StatisticsQuery, candidate: { providerId: string; modelId: string },
  ): ProviderStatistics {
    const global = this.readStatistic(globalScope(query.environment), candidate);
    const context = this.readStatistic(contextScope(query.environment, query.contextKey), candidate);
    const caller = this.readStatistic(callerScope(query.environment, query.callerId, query.contextKey), candidate);
    const globalSuccess = mean(global?.success_alpha, global?.success_beta, 0.5);
    const contextSuccess = mean(context?.success_alpha, context?.success_beta, globalSuccess);
    const successPriorStrength = 12;
    const callerSuccesses = Math.max(0, (caller?.success_alpha ?? 1) - 1);
    const callerFailures = Math.max(0, (caller?.success_beta ?? 1) - 1);
    const globalCompletion = mean(global?.completion_alpha, global?.completion_beta, 0.5);
    const contextCompletion = mean(context?.completion_alpha, context?.completion_beta, globalCompletion);
    const callerCompletions = Math.max(0, (caller?.completion_alpha ?? 1) - 1);
    const callerIncomplete = Math.max(0, (caller?.completion_beta ?? 1) - 1);
    const globalRate = mean(global?.rate_alpha, global?.rate_beta, 0.1);
    const contextRate = mean(context?.rate_alpha, context?.rate_beta, globalRate);
    const callerRateHits = Math.max(0, (caller?.rate_alpha ?? 1) - 1);
    const callerRateMisses = Math.max(0, (caller?.rate_beta ?? 9) - 9);
    return {
      providerId: candidate.providerId,
      modelId: candidate.modelId,
      observations: Math.max(global?.observations ?? 0, context?.observations ?? 0, caller?.observations ?? 0),
      successAlpha: callerSuccesses + contextSuccess * successPriorStrength,
      successBeta: callerFailures + (1 - contextSuccess) * successPriorStrength,
      completionAlpha: callerCompletions + contextCompletion * successPriorStrength,
      completionBeta: callerIncomplete + (1 - contextCompletion) * successPriorStrength,
      rateLimitAlpha: callerRateHits + contextRate * successPriorStrength,
      rateLimitBeta: callerRateMisses + (1 - contextRate) * successPriorStrength,
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

  private readForecast(scope: string, workflowType: string): ForecastRow | undefined {
    return [...this.ctx.storage.sql.exec<ForecastRow>(
      "SELECT * FROM workflow_forecasts WHERE scope_key = ? AND workflow_type = ?", scope, workflowType,
    )][0];
  }

  private purgeExpired(): void {
    const cutoff = Date.now() - retentionMs(this.env);
    this.ctx.storage.sql.exec("DELETE FROM routing_decisions WHERE created_at < ?", cutoff);
    this.ctx.storage.sql.exec("DELETE FROM call_outcomes WHERE completed_at < ?", cutoff);
    this.ctx.storage.sql.exec("DELETE FROM workflow_outcomes WHERE completed_at < ?", cutoff);
  }
}

interface StatisticRow extends Record<string, SqlStorageValue> {
  observations: number; success_alpha: number; success_beta: number;
  completion_alpha: number; completion_beta: number;
  rate_alpha: number; rate_beta: number; quality_mean: number; quality_count: number;
  latency_ewma_ms: number | null; tokens_ewma: number | null;
}

interface ForecastRow extends Record<string, SqlStorageValue> {
  observations: number; completion_alpha: number; completion_beta: number;
  calls_mean: number; calls_m2: number; tokens_mean: number; tokens_m2: number;
}

function scopes(environment: string, callerId: string, contextKey: string): string[] {
  return [globalScope(environment), contextScope(environment, contextKey), callerScope(environment, callerId, contextKey)];
}
function globalScope(environment: string): string { return `global:${environment}`; }
function contextScope(environment: string, contextKey: string): string { return `context:${environment}:${contextKey}`; }
function callerScope(environment: string, callerId: string, contextKey: string): string { return `caller:${environment}:${callerId}:${contextKey}`; }
function mean(alpha: number | undefined, beta: number | undefined, fallback: number): number {
  return alpha !== undefined && beta !== undefined && alpha + beta > 0 ? alpha / (alpha + beta) : fallback;
}
function booleanSql(value: boolean | undefined): number | null { return value === undefined ? null : value ? 1 : 0; }
function scalar(rows: Iterable<{ count: number }>): number { return [...rows][0]?.count ?? 0; }
function retentionMs(env: Env): number {
  const parsed = Number(env.ROUTING_EVENT_RETENTION_MS ?? "2592000000");
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 2_592_000_000;
}
function normalizeControl(control: PolicyControl): PolicyControl {
  const mode = control.mode === "adaptive" || control.mode === "shadow" ? control.mode : "baseline";
  const explorationRate = Math.max(0, Math.min(0.25, Number.isFinite(control.explorationRate) ? control.explorationRate : 0));
  const minObservations = Math.max(0, Math.min(1_000_000, Number.isFinite(control.minObservations)
    ? Math.floor(control.minObservations) : 30));
  return { mode, explorationRate, minObservations };
}
function variance(row: ForecastRow | undefined, field: "calls" | "tokens"): number {
  if (!row || row.observations < 2) return field === "calls" ? row?.calls_mean ?? 1 : 0;
  return (field === "calls" ? row.calls_m2 : row.tokens_m2) / (row.observations - 1);
}
