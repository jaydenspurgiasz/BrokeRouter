import { DurableObject } from "cloudflare:workers";
import type { ProviderRateLimitSettings } from "../../core/types";
import type { Env } from "../../config";

export type AdmissionReason =
  | "cooldown"
  | "safety_budget"
  | "request_rate_limit"
  | "token_rate_limit"
  | "concurrency_limit";

export interface ReservationResult {
  allowed: boolean;
  reservationId?: string;
  retryAfterMs?: number;
  reason?: AdmissionReason;
}

export interface AdmissionQuote extends ReservationResult {
  snapshot: {
    requestCapacity?: number;
    tokenCapacity?: number;
    concurrentAvailable?: number;
    dailyTokensRemaining?: number;
  };
}

export interface UpstreamRateLimitObservation {
  /** Provider-supplied retry/reset time takes precedence over local prediction. */
  retryAfterMs?: number;
  status: number;
}

/**
 * Credential-scoped, strongly-consistent admission controller. It purposely persists metadata
 * only: no user prompts, completions, or provider secrets live here.
 */
export class QuotaCoordinator extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      ctx.storage.sql.exec(`
        CREATE TABLE IF NOT EXISTS quota_state (
          key TEXT PRIMARY KEY,
          value INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS reservations (
          id TEXT PRIMARY KEY,
          tokens INTEGER NOT NULL,
          created_at INTEGER NOT NULL
        );
      `);
    });
  }

  /** Non-mutating admission preview used to gate candidates before policy ranking. */
  async inspect(tokens: number, settings: ProviderRateLimitSettings): Promise<AdmissionQuote> {
    const now = Date.now();
    this.releaseExpiredReservations(now, settings.reservationTtlMs);
    const snapshot = this.snapshot(now, settings);
    const cooldownUntil = this.read("cooldown_until");
    if (cooldownUntil > now) return { ...denied("cooldown", cooldownUntil - now), snapshot };

    const daily = `spent_${utcDay(now)}`;
    const spent = this.read(daily);
    const reservedToday = this.reservedTokensForDay(now);
    if (settings.dailySafetyBudgetTokens > 0 && spent + reservedToday + tokens > settings.dailySafetyBudgetTokens) {
      return { ...denied("safety_budget", msUntilNextUtcDay(now)), snapshot };
    }

    const requestDecision = this.checkBucket("requests", 1, settings.requests, now);
    if (requestDecision) return { ...requestDecision, snapshot };
    const tokenDecision = this.checkBucket("tokens", tokens, settings.tokens, now);
    if (tokenDecision) return { ...tokenDecision, snapshot };
    if (settings.maxConcurrent && this.reservationCount() >= settings.maxConcurrent) {
      return { ...denied("concurrency_limit", this.retryAfterForConcurrency(now, settings.reservationTtlMs)), snapshot };
    }
    return { allowed: true, snapshot };
  }

  async reserve(tokens: number, settings: ProviderRateLimitSettings): Promise<ReservationResult> {
    const now = Date.now();
    this.releaseExpiredReservations(now, settings.reservationTtlMs);

    const cooldownUntil = this.read("cooldown_until");
    if (cooldownUntil > now) return denied("cooldown", cooldownUntil - now);

    const daily = `spent_${utcDay(now)}`;
    const spent = this.read(daily);
    const reservedToday = this.reservedTokensForDay(now);
    if (settings.dailySafetyBudgetTokens > 0 && spent + reservedToday + tokens > settings.dailySafetyBudgetTokens) {
      return denied("safety_budget", msUntilNextUtcDay(now));
    }

    const requestDecision = this.checkBucket("requests", 1, settings.requests, now);
    if (requestDecision) return requestDecision;
    const tokenDecision = this.checkBucket("tokens", tokens, settings.tokens, now);
    if (tokenDecision) return tokenDecision;

    const inFlight = this.reservationCount();
    if (settings.maxConcurrent && inFlight >= settings.maxConcurrent) {
      return denied("concurrency_limit", this.retryAfterForConcurrency(now, settings.reservationTtlMs));
    }

    const id = crypto.randomUUID();
    this.ctx.storage.sql.exec("INSERT INTO reservations (id, tokens, created_at) VALUES (?, ?, ?)", id, tokens, now);
    this.spendBucket("requests", 1, settings.requests, now);
    this.spendBucket("tokens", tokens, settings.tokens, now);
    return { allowed: true, reservationId: id };
  }

  async recordOutcome(
    reservationId: string,
    outcome: { success: boolean; cooldown?: boolean; actualTokens?: number; observation?: UpstreamRateLimitObservation; settings: ProviderRateLimitSettings },
  ): Promise<void> {
    const rows = [...this.ctx.storage.sql.exec<{ tokens: number }>("SELECT tokens FROM reservations WHERE id = ?", reservationId)];
    if (!rows[0]) return;

    const now = Date.now();
    const reservedTokens = rows[0].tokens;
    this.ctx.storage.sql.exec("DELETE FROM reservations WHERE id = ?", reservationId);

    if (outcome.success) {
      const key = `spent_${utcDay(now)}`;
      this.write(key, this.read(key) + Math.max(0, outcome.actualTokens ?? reservedTokens));
      return;
    }

    if (outcome.cooldown) {
      const retryAfterMs = outcome.observation?.retryAfterMs ?? outcome.settings.cooldownMs;
      this.write("cooldown_until", Math.max(this.read("cooldown_until"), now + retryAfterMs));
    }
  }

  /**
   * A persisted token bucket predicts the earliest safe next slot rather than only detecting
   * an already-exhausted fixed window. Values are stored in thousandths to avoid floating point
   * drift while still allowing sub-request refill progress.
   */
  private checkBucket(
    name: "requests" | "tokens",
    amount: number,
    limit: ProviderRateLimitSettings["requests"],
    now: number,
  ): ReservationResult | undefined {
    if (!limit || limit.limit <= 0 || limit.windowMs <= 0) return undefined;
    const available = this.refilledBucket(name, limit, now);
    const required = amount * 1_000;
    if (available >= required) return undefined;
    const missing = required - available;
    const refillPerMs = (limit.limit * 1_000) / limit.windowMs;
    return denied(name === "requests" ? "request_rate_limit" : "token_rate_limit", Math.ceil(missing / refillPerMs));
  }

  private spendBucket(
    name: "requests" | "tokens",
    amount: number,
    limit: ProviderRateLimitSettings["requests"],
    now: number,
  ): void {
    if (!limit || limit.limit <= 0 || limit.windowMs <= 0) return;
    const available = this.refilledBucket(name, limit, now);
    this.write(`${name}_available`, Math.max(0, available - amount * 1_000));
    this.write(`${name}_refilled_at`, now);
  }

  private refilledBucket(name: "requests" | "tokens", limit: NonNullable<ProviderRateLimitSettings["requests"]>, now: number): number {
    const capacity = limit.limit * 1_000;
    const availableKey = `${name}_available`;
    const refilledAtKey = `${name}_refilled_at`;
    const priorAvailable = this.readOptional(availableKey) ?? capacity;
    const refilledAt = this.readOptional(refilledAtKey) ?? now;
    const elapsed = Math.max(0, now - refilledAt);
    return Math.min(capacity, priorAvailable + Math.floor((elapsed * capacity) / limit.windowMs));
  }

  private releaseExpiredReservations(now: number, ttlMs: number): void {
    this.ctx.storage.sql.exec("DELETE FROM reservations WHERE created_at < ?", now - ttlMs);
  }

  private reservationCount(): number {
    return [...this.ctx.storage.sql.exec<{ count: number }>("SELECT COUNT(*) AS count FROM reservations")][0]?.count ?? 0;
  }

  private snapshot(now: number, settings: ProviderRateLimitSettings): AdmissionQuote["snapshot"] {
    const reservations = this.reservationCount();
    const spent = this.read(`spent_${utcDay(now)}`) + this.reservedTokensForDay(now);
    return {
      requestCapacity: settings.requests
        ? Math.floor(this.refilledBucket("requests", settings.requests, now) / 1_000)
        : undefined,
      tokenCapacity: settings.tokens
        ? Math.floor(this.refilledBucket("tokens", settings.tokens, now) / 1_000)
        : undefined,
      concurrentAvailable: settings.maxConcurrent
        ? Math.max(0, settings.maxConcurrent - reservations)
        : undefined,
      dailyTokensRemaining: settings.dailySafetyBudgetTokens > 0
        ? Math.max(0, settings.dailySafetyBudgetTokens - spent)
        : undefined,
    };
  }

  private reservedTokensForDay(now: number): number {
    const start = Date.parse(`${utcDay(now)}T00:00:00.000Z`);
    return [...this.ctx.storage.sql.exec<{ total: number }>("SELECT COALESCE(SUM(tokens), 0) AS total FROM reservations WHERE created_at >= ?", start)][0]?.total ?? 0;
  }

  private retryAfterForConcurrency(now: number, ttlMs: number): number {
    const row = [...this.ctx.storage.sql.exec<{ created_at: number }>("SELECT MIN(created_at) AS created_at FROM reservations")][0];
    return row?.created_at ? Math.max(1, row.created_at + ttlMs - now) : ttlMs;
  }

  private read(key: string): number {
    return this.readOptional(key) ?? 0;
  }

  private readOptional(key: string): number | undefined {
    const row = [...this.ctx.storage.sql.exec<{ value: number }>("SELECT value FROM quota_state WHERE key = ?", key)][0];
    return row?.value;
  }

  private write(key: string, value: number): void {
    this.ctx.storage.sql.exec(
      "INSERT INTO quota_state (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      key,
      value,
    );
  }
}

function denied(reason: AdmissionReason, retryAfterMs: number): ReservationResult {
  return { allowed: false, reason, retryAfterMs: Math.max(1, retryAfterMs) };
}

function utcDay(timestamp: number): string {
  return new Date(timestamp).toISOString().slice(0, 10);
}

function msUntilNextUtcDay(timestamp: number): number {
  const next = new Date(timestamp);
  next.setUTCHours(24, 0, 0, 0);
  return next.getTime() - timestamp;
}
