import { DurableObject } from "cloudflare:workers";
import { NVIDIA_MODELS } from "../../core/models";
import { selectRoutes } from "../../core/route";
import type { GenerationRequest, ProviderRateLimitSettings } from "../../core/types";
import { invokeNvidia } from "../../providers/nvidia";
import type { Env } from "../../worker";
import { QuotaCoordinator } from "./quota-coordinator";

export interface AsyncJob {
  id: string;
  status: "queued" | "running" | "completed" | "failed";
  createdAt: number;
  updatedAt: number;
  result?: Record<string, unknown>;
  error?: string;
}

/** Lightweight durable queue for deferred, non-streaming NVIDIA calls. */
export class AsyncJobQueue extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS jobs (
        id TEXT PRIMARY KEY, request_json TEXT NOT NULL, status TEXT NOT NULL,
        created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, next_attempt_at INTEGER NOT NULL,
        attempts INTEGER NOT NULL, result_json TEXT, error TEXT
      );
    `));
  }

  async enqueue(request: GenerationRequest): Promise<AsyncJob> {
    if (request.stream) throw new Error("Async jobs do not support streaming");
    this.purgeExpired();
    const now = Date.now();
    const id = crypto.randomUUID();
    this.ctx.storage.sql.exec(
      "INSERT INTO jobs (id, request_json, status, created_at, updated_at, next_attempt_at, attempts) VALUES (?, ?, 'queued', ?, ?, ?, 0)",
      id, JSON.stringify(request), now, now, now,
    );
    await this.scheduleNext();
    return { id, status: "queued", createdAt: now, updatedAt: now };
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/enqueue" && request.method === "POST") {
      return Response.json(await this.enqueue(await request.json<GenerationRequest>()));
    }
    if (url.pathname.startsWith("/jobs/") && request.method === "GET") {
      const job = await this.getJob(url.pathname.slice("/jobs/".length));
      return job ? Response.json(job) : new Response(null, { status: 404 });
    }
    return new Response("Not found", { status: 404 });
  }

  async getJob(id: string): Promise<AsyncJob | null> {
    this.purgeExpired();
    const row = [...this.ctx.storage.sql.exec<JobRow>("SELECT * FROM jobs WHERE id = ?", id)][0];
    return row ? publicJob(row) : null;
  }

  async alarm(): Promise<void> {
    this.purgeExpired();
    const now = Date.now();
    const job = [...this.ctx.storage.sql.exec<JobRow>(
      "SELECT * FROM jobs WHERE status = 'queued' AND next_attempt_at <= ? ORDER BY next_attempt_at ASC LIMIT 1", now,
    )][0];
    if (!job) return this.scheduleNext();
    await this.run(job);
    await this.scheduleNext();
  }

  private async run(job: JobRow): Promise<void> {
    const now = Date.now();
    const request = JSON.parse(job.request_json) as GenerationRequest;
    const selection = selectRoutes(request, NVIDIA_MODELS)[0];
    const settings = nvidiaSettings(this.env);
    const coordinator = this.env.QUOTA_COORDINATOR.getByName("nvidia:default");
    const reservation = await coordinator.reserve(selection.reservedTokens, settings);
    if (!reservation.allowed) return this.defer(job.id, job.attempts, reservation.retryAfterMs ?? settings.cooldownMs);

    this.ctx.storage.sql.exec("UPDATE jobs SET status = 'running', updated_at = ? WHERE id = ?", now, job.id);
    try {
      const response = await invokeNvidia(request, selection.model, this.env.NVIDIA_API_KEY);
      if (!response.ok) {
        const retryMs = retryAfter(response) ?? settings.cooldownMs;
        await coordinator.recordOutcome(reservation.reservationId!, { success: false, cooldown: response.status === 429 || response.status >= 500, observation: { status: response.status, retryAfterMs: retryMs }, settings });
        return response.status === 429 || response.status >= 500
          ? this.defer(job.id, job.attempts + 1, retryMs)
          : this.fail(job.id, `Provider returned HTTP ${response.status}`);
      }
      const payload = await response.json<Record<string, unknown>>();
      stripReasoning(payload);
      await coordinator.recordOutcome(reservation.reservationId!, { success: true, settings });
      this.ctx.storage.sql.exec("UPDATE jobs SET status = 'completed', updated_at = ?, result_json = ? WHERE id = ?", Date.now(), JSON.stringify(payload), job.id);
    } catch {
      await coordinator.recordOutcome(reservation.reservationId!, { success: false, cooldown: true, settings });
      await this.defer(job.id, job.attempts + 1, settings.cooldownMs);
    }
  }

  private async defer(id: string, attempts: number, delayMs: number): Promise<void> {
    if (attempts >= maxAttempts(this.env)) return this.fail(id, "Retry limit exceeded");
    const now = Date.now();
    this.ctx.storage.sql.exec("UPDATE jobs SET status = 'queued', attempts = ?, updated_at = ?, next_attempt_at = ? WHERE id = ?", attempts, now, now + Math.max(1, delayMs), id);
  }

  private async fail(id: string, error: string): Promise<void> {
    this.ctx.storage.sql.exec("UPDATE jobs SET status = 'failed', updated_at = ?, error = ? WHERE id = ?", Date.now(), error, id);
  }

  private async scheduleNext(): Promise<void> {
    const row = [...this.ctx.storage.sql.exec<{ next_attempt_at: number }>("SELECT MIN(next_attempt_at) AS next_attempt_at FROM jobs WHERE status = 'queued'")][0];
    if (row?.next_attempt_at) await this.ctx.storage.setAlarm(row.next_attempt_at);
  }

  private purgeExpired(): void {
    this.ctx.storage.sql.exec(
      "DELETE FROM jobs WHERE status IN ('completed', 'failed') AND updated_at < ?",
      Date.now() - retentionMs(this.env),
    );
  }
}

interface JobRow extends Record<string, SqlStorageValue> { id: string; request_json: string; status: AsyncJob["status"]; created_at: number; updated_at: number; next_attempt_at: number; attempts: number; result_json: string | null; error: string | null; }
function publicJob(row: JobRow): AsyncJob { return { id: row.id, status: row.status, createdAt: row.created_at, updatedAt: row.updated_at, result: row.result_json ? JSON.parse(row.result_json) : undefined, error: row.error ?? undefined }; }
function numberSetting(value: string | undefined, fallback: number): number { const parsed = Number(value); return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback; }
function nvidiaSettings(env: Env): ProviderRateLimitSettings { return { dailySafetyBudgetTokens: Number(env.NVIDIA_DAILY_SAFETY_BUDGET_TOKENS ?? "0"), cooldownMs: numberSetting(env.NVIDIA_COOLDOWN_MS, 900000), maxConcurrent: numberSetting(env.NVIDIA_MAX_CONCURRENT, 1), reservationTtlMs: numberSetting(env.NVIDIA_RESERVATION_TTL_MS, 120000) }; }
function maxAttempts(env: Env): number { return numberSetting(env.ASYNC_JOB_MAX_ATTEMPTS, 5); }
function retentionMs(env: Env): number { return numberSetting(env.ASYNC_JOB_RETENTION_MS, 86_400_000); }
function retryAfter(response: Response): number | undefined { const seconds = Number(response.headers.get("retry-after")); return Number.isFinite(seconds) && seconds >= 0 ? seconds * 1000 : undefined; }
function stripReasoning(payload: Record<string, unknown>): void { if (!Array.isArray(payload.choices)) return; for (const choice of payload.choices) { const message = choice && typeof choice === "object" ? (choice as Record<string, unknown>).message : undefined; if (message && typeof message === "object") { delete (message as Record<string, unknown>).reasoning; delete (message as Record<string, unknown>).reasoning_content; } } }
