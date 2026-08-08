import { DurableObject } from "cloudflare:workers";
import type { ProviderRateLimitSettings } from "../../core/types";
import type { Env } from "../../worker";

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

    const requestDecision = this.checkWindow("requests", 1, settings.requests, now);
    if (requestDecision) return requestDecision;
    const tokenDecision = this.checkWindow("tokens", tokens, settings.tokens, now);
    if (tokenDecision) return tokenDecision;

    const inFlight = this.reservationCount();
    if (settings.maxConcurrent && inFlight >= settings.maxConcurrent) {
      return denied("concurrency_limit", this.retryAfterForConcurrency(now, settings.reservationTtlMs));
    }

    const id = crypto.randomUUID();
    this.ctx.storage.sql.exec("INSERT INTO reservations (id, tokens, created_at) VALUES (?, ?, ?)", id, tokens, now);
    this.incrementWindow("requests", 1, settings.requests, now);
    this.incrementWindow("tokens", tokens, settings.tokens, now);
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

  private checkWindow(
    name: "requests" | "tokens",
    amount: number,
    limit: ProviderRateLimitSettings["requests"],
    now: number,
  ): ReservationResult | undefined {
    if (!limit || limit.limit <= 0 || limit.windowMs <= 0) return undefined;
    const windowStart = Math.floor(now / limit.windowMs) * limit.windowMs;
    const key = `${name}_${windowStart}`;
    if (this.read(key) + amount <= limit.limit) return undefined;
    return denied(name === "requests" ? "request_rate_limit" : "token_rate_limit", windowStart + limit.windowMs - now);
  }

  private incrementWindow(
    name: "requests" | "tokens",
    amount: number,
    limit: ProviderRateLimitSettings["requests"],
    now: number,
  ): void {
    if (!limit || limit.limit <= 0 || limit.windowMs <= 0) return;
    const key = `${name}_${Math.floor(now / limit.windowMs) * limit.windowMs}`;
    this.write(key, this.read(key) + amount);
  }

  private releaseExpiredReservations(now: number, ttlMs: number): void {
    this.ctx.storage.sql.exec("DELETE FROM reservations WHERE created_at < ?", now - ttlMs);
  }

  private reservationCount(): number {
    return [...this.ctx.storage.sql.exec<{ count: number }>("SELECT COUNT(*) AS count FROM reservations")][0]?.count ?? 0;
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
    const row = [...this.ctx.storage.sql.exec<{ value: number }>("SELECT value FROM quota_state WHERE key = ?", key)][0];
    return row?.value ?? 0;
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
