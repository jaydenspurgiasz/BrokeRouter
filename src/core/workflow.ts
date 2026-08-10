import { RouterError, type GenerationRequest } from "./types";

export type WorkflowType = "single-turn" | "tool-agent" | "parallel-research" | "coding-agent" | "summarization" | "batch";
export type QualityTier = "economy" | "balanced" | "reasoning";

export interface WorkflowSpec {
  workflowType: WorkflowType;
  expectedCalls: number;
  maxCalls: number;
  maxConcurrency: number;
  estimatedTotalTokens: number;
  deadlineMs?: number;
  qualityTier: QualityTier;
  priority: number;
}

export interface WorkflowRecord extends WorkflowSpec {
  id: string;
  ownerId: string;
  environment: string;
  status: "active" | "completed" | "failed" | "cancelled";
  createdAt: number;
  updatedAt: number;
  deadlineAt?: number;
  callsStarted: number;
  callsCompleted: number;
  inFlight: number;
  actualTokens: number;
  primaryProvider?: string;
  primaryModel?: string;
  quality?: number;
  success?: boolean;
}

export interface WorkflowOutcomeInput {
  success: boolean;
  quality?: number;
  validatorPassed?: boolean;
  deadlineMet?: boolean;
}

export function parseWorkflowSpec(
  value: unknown,
  defaults: Partial<Pick<WorkflowSpec, "expectedCalls" | "maxCalls" | "estimatedTotalTokens">> = {},
): WorkflowSpec {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid("Workflow body must be an object.");
  const body = value as Record<string, unknown>;
  const workflowType = body.workflowType ?? "single-turn";
  const qualityTier = body.qualityTier ?? "balanced";
  if (!WORKFLOW_TYPES.has(workflowType as WorkflowType)) invalid("workflowType is not supported.");
  if (!QUALITY_TIERS.has(qualityTier as QualityTier)) invalid("qualityTier is not supported.");
  const expectedCalls = integer(body.expectedCalls, 1, 1_000, defaults.expectedCalls ?? 1, "expectedCalls");
  const maxCalls = integer(body.maxCalls, expectedCalls, 10_000, defaults.maxCalls ?? expectedCalls, "maxCalls");
  if (maxCalls < expectedCalls) invalid("maxCalls cannot be lower than expectedCalls.");
  return {
    workflowType: workflowType as WorkflowType,
    expectedCalls,
    maxCalls,
    maxConcurrency: integer(body.maxConcurrency, 1, 1_000, 1, "maxConcurrency"),
    estimatedTotalTokens: integer(
      body.estimatedTotalTokens, 1, Number.MAX_SAFE_INTEGER,
      defaults.estimatedTotalTokens ?? 1_024 * expectedCalls, "estimatedTotalTokens",
    ),
    deadlineMs: optionalInteger(body.deadlineMs, 1, 7 * 24 * 60 * 60 * 1_000, "deadlineMs"),
    qualityTier: qualityTier as QualityTier,
    priority: integer(body.priority, 0, 100, 50, "priority"),
  };
}

export function parseWorkflowOutcome(value: unknown): WorkflowOutcomeInput {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid("Outcome body must be an object.");
  const body = value as Record<string, unknown>;
  if (typeof body.success !== "boolean") invalid("success must be boolean.");
  const quality = body.quality === undefined ? undefined : finite(body.quality, 0, 1, "quality");
  if (body.validatorPassed !== undefined && typeof body.validatorPassed !== "boolean") invalid("validatorPassed must be boolean.");
  if (body.deadlineMet !== undefined && typeof body.deadlineMet !== "boolean") invalid("deadlineMet must be boolean.");
  return {
    success: body.success as boolean,
    quality,
    validatorPassed: body.validatorPassed as boolean | undefined,
    deadlineMet: body.deadlineMet as boolean | undefined,
  };
}

/** Server-owned workflow fields replace untrusted per-call hints. */
export function applyWorkflowContext(request: GenerationRequest, workflow: WorkflowRecord): GenerationRequest {
  const remainingCalls = Math.max(1, workflow.expectedCalls - workflow.callsStarted);
  const remainingTokens = Math.max(1, workflow.estimatedTotalTokens - workflow.actualTokens);
  return {
    ...request,
    route: {
      ...request.route,
      workflowId: workflow.id,
      workflowType: workflow.workflowType,
      expectedCalls: remainingCalls,
      maxCalls: Math.max(1, workflow.maxCalls - workflow.callsStarted),
      maxConcurrency: workflow.maxConcurrency,
      estimatedTotalTokens: remainingTokens,
      qualityTier: workflow.qualityTier,
      deadlineMs: workflow.deadlineAt ? Math.max(1, workflow.deadlineAt - Date.now()) : undefined,
      preferredProviderId: workflow.primaryProvider,
    },
  };
}

export function workflowContextKey(request: GenerationRequest): string {
  return `${request.route?.workflowType ?? "single-turn"}:${request.route?.qualityTier ?? request.route?.tier ?? "balanced"}`;
}

const WORKFLOW_TYPES = new Set<WorkflowType>(["single-turn", "tool-agent", "parallel-research", "coding-agent", "summarization", "batch"]);
const QUALITY_TIERS = new Set<QualityTier>(["economy", "balanced", "reasoning"]);

function integer(value: unknown, minimum: number, maximum: number, fallback: number, name: string): number {
  if (value === undefined) return fallback;
  const parsed = finite(value, minimum, maximum, name);
  if (!Number.isInteger(parsed)) invalid(`${name} must be an integer.`);
  return parsed;
}

function optionalInteger(value: unknown, minimum: number, maximum: number, name: string): number | undefined {
  return value === undefined ? undefined : integer(value, minimum, maximum, minimum, name);
}

function finite(value: unknown, minimum: number, maximum: number, name: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < minimum || value > maximum) {
    invalid(`${name} must be between ${minimum} and ${maximum}.`);
  }
  return value as number;
}

function invalid(message: string): never {
  throw new RouterError("invalid_request", message, 400);
}
