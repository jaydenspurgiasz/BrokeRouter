// @ts-ignore Node's built-in SQLite types are not included in the Worker typecheck environment.
import { DatabaseSync } from "node:sqlite";
import type { ProviderRateLimitSettings } from "../../core/types";

export interface LocalAdmission {
  allowed: boolean;
  reservationId?: string;
  retryAfterMs?: number;
}

export class SqliteState {
  private readonly db: any;

  constructor(path: string) {
    this.db = new DatabaseSync(path);
    this.db.exec(`
      PRAGMA journal_mode=WAL;
      PRAGMA foreign_keys=ON;
      PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS quota_values (
        scope TEXT NOT NULL, key TEXT NOT NULL, value INTEGER NOT NULL,
        PRIMARY KEY (scope, key)
      );
      CREATE TABLE IF NOT EXISTS reservations (
        id TEXT PRIMARY KEY, scope TEXT NOT NULL, tokens INTEGER NOT NULL, created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS reservations_scope_created ON reservations(scope, created_at);
      CREATE TABLE IF NOT EXISTS affinity (
        environment TEXT NOT NULL, caller_id TEXT NOT NULL, alias TEXT NOT NULL,
        key_hash TEXT NOT NULL, provider TEXT NOT NULL, credential_scope TEXT NOT NULL,
        model_id TEXT NOT NULL, updated_at INTEGER NOT NULL, expires_at INTEGER NOT NULL,
        PRIMARY KEY (environment, caller_id, alias, key_hash)
      );
    `);
    const affinityColumns = this.db.prepare("PRAGMA table_info(affinity)").all();
    if (!affinityColumns.some((column: { name: string }) => column.name === "expires_at")) {
      this.db.exec("ALTER TABLE affinity ADD COLUMN expires_at INTEGER NOT NULL DEFAULT 0");
    }
    this.db.exec("PRAGMA user_version=1");
  }

  close(): void { this.db.close(); }

  inspect(scope: string, tokens: number, settings: ProviderRateLimitSettings): LocalAdmission {
    return this.transaction(() => this.admission(scope, tokens, settings, false));
  }

  reserve(scope: string, tokens: number, settings: ProviderRateLimitSettings): LocalAdmission {
    return this.transaction(() => this.admission(scope, tokens, settings, true));
  }

  settle(scope: string, reservationId: string, outcome: {
    success: boolean; actualTokens?: number; cooldown?: boolean; retryAfterMs?: number;
    settings: ProviderRateLimitSettings;
  }): void {
    this.transaction(() => {
      const row = this.db.prepare("SELECT tokens FROM reservations WHERE id = ? AND scope = ?").get(reservationId, scope);
      if (!row) return;
      this.db.prepare("DELETE FROM reservations WHERE id = ?").run(reservationId);
      const now = Date.now();
      if (outcome.success) {
        const key = `spent_${utcDay(now)}`;
        this.write(scope, key, this.read(scope, key) + Math.max(0, outcome.actualTokens ?? row.tokens));
      } else if (outcome.cooldown) {
        const until = now + (outcome.retryAfterMs ?? outcome.settings.cooldownMs);
        this.write(scope, "cooldown_until", Math.max(until, this.read(scope, "cooldown_until")));
      }
    });
  }

  getAffinity(environment: string, callerId: string, alias: string, keyHash: string):
    { provider: string; credentialScope: string; modelId: string } | undefined {
    return this.db.prepare(`SELECT provider, credential_scope AS credentialScope, model_id AS modelId
      FROM affinity WHERE environment = ? AND caller_id = ? AND alias = ? AND key_hash = ? AND expires_at > ?`)
      .get(environment, callerId, alias, keyHash, Date.now());
  }

  setAffinity(environment: string, callerId: string, alias: string, keyHash: string,
    provider: string, credentialScope: string, modelId: string): void {
    this.db.prepare(`INSERT INTO affinity
      (environment, caller_id, alias, key_hash, provider, credential_scope, model_id, updated_at, expires_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(environment, caller_id, alias, key_hash) DO UPDATE SET
      provider=excluded.provider, credential_scope=excluded.credential_scope,
      model_id=excluded.model_id, updated_at=excluded.updated_at, expires_at=excluded.expires_at`)
      .run(environment, callerId, alias, keyHash, provider, credentialScope, modelId,
        Date.now(), Date.now() + 7 * 24 * 60 * 60 * 1_000);
  }

  private admission(scope: string, tokens: number, settings: ProviderRateLimitSettings, mutate: boolean): LocalAdmission {
    const now = Date.now();
    this.db.prepare("DELETE FROM reservations WHERE scope = ? AND created_at < ?")
      .run(scope, now - settings.reservationTtlMs);
    const cooldownUntil = this.read(scope, "cooldown_until");
    if (cooldownUntil > now) return { allowed: false, retryAfterMs: cooldownUntil - now };
    const reserved = this.db.prepare("SELECT COALESCE(SUM(tokens), 0) AS total, COUNT(*) AS count FROM reservations WHERE scope = ?")
      .get(scope);
    const spent = this.read(scope, `spent_${utcDay(now)}`);
    if (settings.dailySafetyBudgetTokens > 0 && spent + reserved.total + tokens > settings.dailySafetyBudgetTokens) {
      return { allowed: false, retryAfterMs: msUntilNextUtcDay(now) };
    }
    const requestDelay = this.bucketDelay(scope, "requests", 1, settings.requests, now);
    if (requestDelay !== undefined) return { allowed: false, retryAfterMs: requestDelay };
    const tokenDelay = this.bucketDelay(scope, "tokens", tokens, settings.tokens, now);
    if (tokenDelay !== undefined) return { allowed: false, retryAfterMs: tokenDelay };
    if (settings.maxConcurrent && reserved.count >= settings.maxConcurrent) {
      const oldest = this.db.prepare("SELECT MIN(created_at) AS value FROM reservations WHERE scope = ?").get(scope).value;
      return { allowed: false, retryAfterMs: Math.max(1, oldest + settings.reservationTtlMs - now) };
    }
    if (!mutate) return { allowed: true };
    const id = crypto.randomUUID();
    this.db.prepare("INSERT INTO reservations (id, scope, tokens, created_at) VALUES (?, ?, ?, ?)")
      .run(id, scope, tokens, now);
    this.spendBucket(scope, "requests", 1, settings.requests, now);
    this.spendBucket(scope, "tokens", tokens, settings.tokens, now);
    return { allowed: true, reservationId: id };
  }

  private bucketDelay(scope: string, name: string, amount: number,
    limit: ProviderRateLimitSettings["requests"], now: number): number | undefined {
    if (!limit) return undefined;
    const available = this.refilled(scope, name, limit, now);
    const missing = amount * 1_000 - available;
    return missing > 0 ? Math.ceil(missing / ((limit.limit * 1_000) / limit.windowMs)) : undefined;
  }

  private spendBucket(scope: string, name: string, amount: number,
    limit: ProviderRateLimitSettings["requests"], now: number): void {
    if (!limit) return;
    this.write(scope, `${name}_available`, Math.max(0, this.refilled(scope, name, limit, now) - amount * 1_000));
    this.write(scope, `${name}_refilled_at`, now);
  }

  private refilled(scope: string, name: string, limit: NonNullable<ProviderRateLimitSettings["requests"]>, now: number): number {
    const capacity = limit.limit * 1_000;
    const available = this.readOptional(scope, `${name}_available`) ?? capacity;
    const at = this.readOptional(scope, `${name}_refilled_at`) ?? now;
    return Math.min(capacity, available + Math.floor(Math.max(0, now - at) * capacity / limit.windowMs));
  }

  private read(scope: string, key: string): number { return this.readOptional(scope, key) ?? 0; }
  private readOptional(scope: string, key: string): number | undefined {
    return this.db.prepare("SELECT value FROM quota_values WHERE scope = ? AND key = ?").get(scope, key)?.value;
  }
  private write(scope: string, key: string, value: number): void {
    this.db.prepare(`INSERT INTO quota_values(scope, key, value) VALUES (?, ?, ?)
      ON CONFLICT(scope, key) DO UPDATE SET value=excluded.value`).run(scope, key, Math.floor(value));
  }
  private transaction<T>(fn: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try { const result = fn(); this.db.exec("COMMIT"); return result; }
    catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }
}

function utcDay(now: number): string { return new Date(now).toISOString().slice(0, 10); }
function msUntilNextUtcDay(now: number): number {
  const date = new Date(now); return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() + 1) - now;
}
