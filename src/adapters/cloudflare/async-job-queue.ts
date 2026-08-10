import { DurableObject } from "cloudflare:workers";
import type { Env } from "../../config";
import { RouterError, type GenerationRequest, type ProviderRateLimitSettings } from "../../core/types";
import { executeGeneration } from "./execution";

export interface AsyncJob {
  id: string;
  status: "queued" | "running" | "completed" | "failed";
  createdAt: number;
  updatedAt: number;
  result?: Record<string, unknown>;
  error?: string;
}

/** Durable, caller-isolated queue using the same multi-provider planner as interactive calls. */
export class AsyncJobQueue extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      ctx.storage.sql.exec(`
        CREATE TABLE IF NOT EXISTS jobs (
          id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, owner_environment TEXT NOT NULL,
          owner_limits_json TEXT NOT NULL,
          request_json TEXT NOT NULL, status TEXT NOT NULL,
          created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, next_attempt_at INTEGER NOT NULL,
          attempts INTEGER NOT NULL, result_json TEXT, error TEXT
        );
      `);
      const columns = [...ctx.storage.sql.exec<{ name: string }>("PRAGMA table_info(jobs)")];
      if (!columns.some((column) => column.name === "owner_id")) {
        ctx.storage.sql.exec("ALTER TABLE jobs ADD COLUMN owner_id TEXT NOT NULL DEFAULT 'legacy-local'");
      }
      if (!columns.some((column) => column.name === "owner_environment")) {
        ctx.storage.sql.exec("ALTER TABLE jobs ADD COLUMN owner_environment TEXT NOT NULL DEFAULT 'development'");
      }
      if (!columns.some((column) => column.name === "owner_limits_json")) {
        ctx.storage.sql.exec("ALTER TABLE jobs ADD COLUMN owner_limits_json TEXT NOT NULL DEFAULT '{}'");
      }
      ctx.storage.sql.exec("CREATE INDEX IF NOT EXISTS jobs_owner_id ON jobs(owner_id, id)");
    });
  }

  async enqueue(
    request: GenerationRequest, callerId: string, environment: string, rateLimits: ProviderRateLimitSettings,
  ): Promise<AsyncJob> {
    if (request.stream) throw new Error("Async jobs do not support streaming");
    this.purgeExpired();
    const now = Date.now();
    const id = crypto.randomUUID();
    this.ctx.storage.sql.exec(
      "INSERT INTO jobs (id, owner_id, owner_environment, owner_limits_json, request_json, status, created_at, updated_at, next_attempt_at, attempts) VALUES (?, ?, ?, ?, ?, 'queued', ?, ?, ?, 0)",
      id, callerId, environment, JSON.stringify(rateLimits), JSON.stringify(request), now, now, now,
    );
    await this.scheduleNext();
    return { id, status: "queued", createdAt: now, updatedAt: now };
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/enqueue" && request.method === "POST") {
      const payload = await request.json<{
        request: GenerationRequest; callerId: string; environment: string; rateLimits: ProviderRateLimitSettings;
      }>();
      return Response.json(await this.enqueue(payload.request, payload.callerId, payload.environment, payload.rateLimits));
    }
    if (url.pathname.startsWith("/jobs/") && request.method === "GET") {
      const job = await this.getJob(
        decodeURIComponent(url.pathname.slice("/jobs/".length)),
        url.searchParams.get("callerId") ?? "",
      );
      return job ? Response.json(job) : new Response(null, { status: 404 });
    }
    return new Response("Not found", { status: 404 });
  }

  async getJob(id: string, callerId: string): Promise<AsyncJob | null> {
    this.purgeExpired();
    const row = [...this.ctx.storage.sql.exec<JobRow>(
      "SELECT * FROM jobs WHERE id = ? AND owner_id = ?", id, callerId,
    )][0];
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
    const request = JSON.parse(job.request_json) as GenerationRequest;
    this.ctx.storage.sql.exec("UPDATE jobs SET status = 'running', updated_at = ? WHERE id = ?", Date.now(), job.id);
    try {
      const response = await executeGeneration(
        request,
        this.env,
        (promise) => this.ctx.waitUntil(promise),
        {
          allowInlineWait: false,
          identity: {
            callerId: job.owner_id,
            environment: job.owner_environment,
            rateLimits: JSON.parse(job.owner_limits_json) as ProviderRateLimitSettings,
          },
        },
      );
      if (!response.ok) {
        const temporary = response.status === 429 || response.status >= 500;
        return temporary
          ? this.defer(job.id, job.attempts + 1, retryAfter(response) ?? 1_000)
          : this.fail(job.id, `Provider returned HTTP ${response.status}`);
      }
      const payload = await response.json<Record<string, unknown>>();
      this.ctx.storage.sql.exec(
        "UPDATE jobs SET status = 'completed', updated_at = ?, result_json = ? WHERE id = ?",
        Date.now(), JSON.stringify(payload), job.id,
      );
    } catch (error) {
      if (error instanceof RouterError && error.code === "provider_unavailable") {
        return this.defer(job.id, job.attempts, error.retryAfterMs ?? 1_000);
      }
      await this.defer(job.id, job.attempts + 1, error instanceof RouterError ? error.retryAfterMs ?? 1_000 : 1_000);
    }
  }

  private async defer(id: string, attempts: number, delayMs: number): Promise<void> {
    if (attempts >= maxAttempts(this.env)) return this.fail(id, "Retry limit exceeded");
    const now = Date.now();
    this.ctx.storage.sql.exec(
      "UPDATE jobs SET status = 'queued', attempts = ?, updated_at = ?, next_attempt_at = ? WHERE id = ?",
      attempts, now, now + Math.max(1, delayMs), id,
    );
  }

  private async fail(id: string, error: string): Promise<void> {
    this.ctx.storage.sql.exec(
      "UPDATE jobs SET status = 'failed', updated_at = ?, error = ? WHERE id = ?",
      Date.now(), error, id,
    );
  }

  private async scheduleNext(): Promise<void> {
    const row = [...this.ctx.storage.sql.exec<{ next_attempt_at: number }>(
      "SELECT MIN(next_attempt_at) AS next_attempt_at FROM jobs WHERE status = 'queued'",
    )][0];
    if (row?.next_attempt_at) await this.ctx.storage.setAlarm(row.next_attempt_at);
  }

  private purgeExpired(): void {
    this.ctx.storage.sql.exec(
      "DELETE FROM jobs WHERE status IN ('completed', 'failed') AND updated_at < ?",
      Date.now() - retentionMs(this.env),
    );
  }
}

interface JobRow extends Record<string, SqlStorageValue> {
  id: string;
  owner_id: string;
  owner_environment: string;
  owner_limits_json: string;
  request_json: string;
  status: AsyncJob["status"];
  created_at: number;
  updated_at: number;
  next_attempt_at: number;
  attempts: number;
  result_json: string | null;
  error: string | null;
}

function publicJob(row: JobRow): AsyncJob {
  return {
    id: row.id,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    result: row.result_json ? JSON.parse(row.result_json) : undefined,
    error: row.error ?? undefined,
  };
}

function numberSetting(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function maxAttempts(env: Env): number { return numberSetting(env.ASYNC_JOB_MAX_ATTEMPTS, 5); }
function retentionMs(env: Env): number { return numberSetting(env.ASYNC_JOB_RETENTION_MS, 86_400_000); }
function retryAfter(response: Response): number | undefined {
  const seconds = Number(response.headers.get("retry-after"));
  return Number.isFinite(seconds) && seconds >= 0 ? seconds * 1_000 : undefined;
}
