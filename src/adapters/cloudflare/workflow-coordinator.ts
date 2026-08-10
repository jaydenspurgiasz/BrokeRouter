import { DurableObject } from "cloudflare:workers";
import type { Env } from "../../config";
import { RouterError } from "../../core/types";
import type { WorkflowOutcomeInput, WorkflowRecord, WorkflowSpec } from "../../core/workflow";

export interface WorkflowCallLease {
  callId: string;
  workflow: WorkflowRecord;
}

/** Strongly consistent workflow lifecycle, ownership, concurrency, and call accounting. */
export class WorkflowCoordinator extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS workflows (
        id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, environment TEXT NOT NULL, status TEXT NOT NULL,
        workflow_type TEXT NOT NULL, expected_calls INTEGER NOT NULL, max_calls INTEGER NOT NULL,
        max_concurrency INTEGER NOT NULL, estimated_total_tokens INTEGER NOT NULL,
        deadline_at INTEGER, quality_tier TEXT NOT NULL, priority INTEGER NOT NULL,
        created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, calls_started INTEGER NOT NULL DEFAULT 0,
        calls_completed INTEGER NOT NULL DEFAULT 0, in_flight INTEGER NOT NULL DEFAULT 0,
        actual_tokens INTEGER NOT NULL DEFAULT 0, primary_provider TEXT, primary_model TEXT,
        success INTEGER, quality REAL, validator_passed INTEGER, deadline_met INTEGER
      );
      CREATE TABLE IF NOT EXISTS workflow_calls (
        id TEXT PRIMARY KEY, workflow_id TEXT NOT NULL, decision_id TEXT NOT NULL,
        provider_id TEXT NOT NULL, model_id TEXT NOT NULL, started_at INTEGER NOT NULL,
        completed_at INTEGER, success INTEGER, actual_tokens INTEGER
      );
      CREATE INDEX IF NOT EXISTS workflows_owner ON workflows(owner_id, id);
      CREATE INDEX IF NOT EXISTS workflow_calls_workflow ON workflow_calls(workflow_id, started_at);
    `));
  }

  async create(id: string, ownerId: string, environment: string, spec: WorkflowSpec): Promise<WorkflowRecord> {
    this.purgeExpired();
    const now = Date.now();
    const deadlineAt = spec.deadlineMs ? now + spec.deadlineMs : null;
    this.ctx.storage.sql.exec(
      `INSERT INTO workflows
       (id, owner_id, environment, status, workflow_type, expected_calls, max_calls,
        max_concurrency, estimated_total_tokens, deadline_at, quality_tier, priority, created_at, updated_at)
       VALUES (?, ?, ?, 'active', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      id, ownerId, environment, spec.workflowType, spec.expectedCalls, spec.maxCalls,
      spec.maxConcurrency, spec.estimatedTotalTokens, deadlineAt, spec.qualityTier,
      spec.priority, now, now,
    );
    if (deadlineAt) await this.ctx.storage.setAlarm(deadlineAt);
    return this.getOwned(id, ownerId);
  }

  async get(id: string, ownerId: string): Promise<WorkflowRecord | null> {
    this.purgeExpired();
    const row = this.readOwned(id, ownerId);
    return row ? publicWorkflow(row) : null;
  }

  async inspectForCall(id: string, ownerId: string): Promise<WorkflowRecord> {
    const workflow = await this.get(id, ownerId);
    if (!workflow) throw new RouterError("invalid_request", "Workflow not found.", 404);
    assertCallable(workflow);
    return workflow;
  }

  async beginCall(
    id: string, ownerId: string, decisionId: string, providerId: string, modelId: string,
  ): Promise<WorkflowCallLease> {
    const row = this.readOwned(id, ownerId);
    if (!row) throw new RouterError("invalid_request", "Workflow not found.", 404);
    const workflow = publicWorkflow(row);
    // No await may occur between this check and the SQL updates below. That makes the capacity
    // check and lease acquisition one Durable Object input-gate transaction.
    assertCallable(workflow);
    const callId = crypto.randomUUID();
    const now = Date.now();
    this.ctx.storage.sql.exec(
      `INSERT INTO workflow_calls (id, workflow_id, decision_id, provider_id, model_id, started_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      callId, id, decisionId, providerId, modelId, now,
    );
    this.ctx.storage.sql.exec(
      `UPDATE workflows SET calls_started = calls_started + 1, in_flight = in_flight + 1,
       primary_provider = COALESCE(primary_provider, ?), primary_model = COALESCE(primary_model, ?), updated_at = ?
       WHERE id = ? AND owner_id = ?`,
      providerId, modelId, now, id, ownerId,
    );
    return { callId, workflow: this.getOwned(id, ownerId) };
  }

  async finishCall(callId: string, success: boolean, actualTokens?: number): Promise<void> {
    const call = [...this.ctx.storage.sql.exec<{ workflow_id: string; completed_at: number | null }>(
      "SELECT workflow_id, completed_at FROM workflow_calls WHERE id = ?", callId,
    )][0];
    if (!call || call.completed_at) return;
    const now = Date.now();
    const tokens = Math.max(0, actualTokens ?? 0);
    this.ctx.storage.sql.exec(
      "UPDATE workflow_calls SET completed_at = ?, success = ?, actual_tokens = ? WHERE id = ?",
      now, success ? 1 : 0, tokens, callId,
    );
    this.ctx.storage.sql.exec(
      `UPDATE workflows SET calls_completed = calls_completed + 1, in_flight = MAX(0, in_flight - 1),
       actual_tokens = actual_tokens + ?, updated_at = ? WHERE id = ?`,
      tokens, now, call.workflow_id,
    );
  }

  async complete(id: string, ownerId: string, outcome: WorkflowOutcomeInput): Promise<WorkflowRecord> {
    const row = this.readOwned(id, ownerId);
    if (!row) throw new RouterError("invalid_request", "Workflow not found.", 404);
    const workflow = publicWorkflow(row);
    if (workflow.status !== "active") throw new RouterError("workflow_unavailable", "Workflow already has a terminal outcome.", 409);
    if (workflow.inFlight > 0) throw new RouterError("workflow_unavailable", "Workflow still has calls in flight.", 409);
    const now = Date.now();
    const deadlineMet = outcome.deadlineMet ?? (workflow.deadlineAt === undefined || now <= workflow.deadlineAt);
    this.ctx.storage.sql.exec(
      `UPDATE workflows SET status = ?, success = ?, quality = ?, validator_passed = ?,
       deadline_met = ?, updated_at = ? WHERE id = ? AND owner_id = ?`,
      outcome.success ? "completed" : "failed", outcome.success ? 1 : 0, outcome.quality ?? null,
      booleanSql(outcome.validatorPassed), deadlineMet ? 1 : 0, now, id, ownerId,
    );
    return this.getOwned(id, ownerId);
  }

  async alarm(): Promise<void> {
    const row = [...this.ctx.storage.sql.exec<WorkflowRow>(
      "SELECT * FROM workflows WHERE status = 'active' AND deadline_at IS NOT NULL ORDER BY deadline_at LIMIT 1",
    )][0];
    if (!row) return;
    const now = Date.now();
    if (row.deadline_at && row.deadline_at > now) {
      await this.ctx.storage.setAlarm(row.deadline_at);
      return;
    }
    if (row.in_flight > 0) {
      await this.ctx.storage.setAlarm(now + 1_000);
      return;
    }
    this.ctx.storage.sql.exec(
      "UPDATE workflows SET status = 'failed', success = 0, deadline_met = 0, updated_at = ? WHERE id = ? AND status = 'active'",
      now, row.id,
    );
    await this.env.ROUTING_STATE.getByName(row.environment).recordWorkflowOutcome({
      workflowId: row.id,
      completedAt: now,
      callerId: row.owner_id,
      environment: row.environment,
      contextKey: `${row.workflow_type}:${row.quality_tier}`,
      providerId: row.primary_provider ?? undefined,
      modelId: row.primary_model ?? undefined,
      success: false,
      deadlineMet: false,
      callsCompleted: row.calls_completed,
      actualTokens: row.actual_tokens,
    });
  }

  private readOwned(id: string, ownerId: string): WorkflowRow | undefined {
    return [...this.ctx.storage.sql.exec<WorkflowRow>(
      "SELECT * FROM workflows WHERE id = ? AND owner_id = ?", id, ownerId,
    )][0];
  }

  private getOwned(id: string, ownerId: string): WorkflowRecord {
    const row = this.readOwned(id, ownerId);
    if (!row) throw new RouterError("invalid_request", "Workflow not found.", 404);
    return publicWorkflow(row);
  }

  private purgeExpired(): void {
    const cutoff = Date.now() - retentionMs(this.env);
    this.ctx.storage.sql.exec("DELETE FROM workflow_calls WHERE workflow_id IN (SELECT id FROM workflows WHERE status != 'active' AND updated_at < ?)", cutoff);
    this.ctx.storage.sql.exec("DELETE FROM workflows WHERE status != 'active' AND updated_at < ?", cutoff);
  }
}

interface WorkflowRow extends Record<string, SqlStorageValue> {
  id: string; owner_id: string; environment: string; status: WorkflowRecord["status"];
  workflow_type: WorkflowRecord["workflowType"]; expected_calls: number; max_calls: number;
  max_concurrency: number; estimated_total_tokens: number; deadline_at: number | null;
  quality_tier: WorkflowRecord["qualityTier"]; priority: number; created_at: number; updated_at: number;
  calls_started: number; calls_completed: number; in_flight: number; actual_tokens: number;
  primary_provider: string | null; primary_model: string | null; success: number | null; quality: number | null;
}

function publicWorkflow(row: WorkflowRow): WorkflowRecord {
  return {
    id: row.id, ownerId: row.owner_id, environment: row.environment, status: row.status,
    workflowType: row.workflow_type, expectedCalls: row.expected_calls, maxCalls: row.max_calls,
    maxConcurrency: row.max_concurrency, estimatedTotalTokens: row.estimated_total_tokens,
    deadlineAt: row.deadline_at ?? undefined, qualityTier: row.quality_tier, priority: row.priority,
    createdAt: row.created_at, updatedAt: row.updated_at, callsStarted: row.calls_started,
    callsCompleted: row.calls_completed, inFlight: row.in_flight, actualTokens: row.actual_tokens,
    primaryProvider: row.primary_provider ?? undefined, primaryModel: row.primary_model ?? undefined,
    success: row.success === null ? undefined : row.success === 1, quality: row.quality ?? undefined,
  };
}

function assertCallable(workflow: WorkflowRecord): void {
  if (workflow.status !== "active") throw new RouterError("workflow_unavailable", "Workflow is not active.", 409);
  if (workflow.deadlineAt && workflow.deadlineAt <= Date.now()) throw new RouterError("workflow_unavailable", "Workflow deadline has passed.", 409);
  if (workflow.callsStarted >= workflow.maxCalls) throw new RouterError("workflow_unavailable", "Workflow call limit is exhausted.", 409);
  if (workflow.inFlight >= workflow.maxConcurrency) throw new RouterError("workflow_unavailable", "Workflow concurrency limit is reached.", 409);
}

function booleanSql(value: boolean | undefined): number | null { return value === undefined ? null : value ? 1 : 0; }
function retentionMs(env: Env): number {
  const parsed = Number(env.WORKFLOW_RETENTION_MS ?? "2592000000");
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 2_592_000_000;
}
