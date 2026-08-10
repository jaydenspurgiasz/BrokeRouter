import type { Env } from "./config";
import { defaultPolicyControl, executeGeneration } from "./adapters/cloudflare/execution";
import { registeredProviders } from "./adapters/cloudflare/provider-registry";
import { QuotaCoordinator } from "./adapters/cloudflare/quota-coordinator";
import { AsyncJobQueue } from "./adapters/cloudflare/async-job-queue";
import { RoutingState } from "./adapters/cloudflare/routing-state";
import { WorkflowCoordinator } from "./adapters/cloudflare/workflow-coordinator";
import { authenticateCaller, requireScope } from "./core/auth";
import { RouterError, type GenerationRequest } from "./core/types";
import { parseWorkflowOutcome, parseWorkflowSpec } from "./core/workflow";

export { QuotaCoordinator, AsyncJobQueue, RoutingState, WorkflowCoordinator };
export type { Env } from "./config";

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    try {
      const url = new URL(request.url);
      if (url.pathname === "/health" && request.method === "GET") {
        return Response.json({ ok: true, service: "broke-router" });
      }

      const caller = await authenticateCaller(request, env);
      if (url.pathname === "/v1/models" && request.method === "GET") {
        requireScope(caller, "models:read");
        return Response.json({
          object: "list",
          data: registeredProviders(env).flatMap((provider) => provider.models),
        });
      }
      if (url.pathname === "/v1/workflows" && request.method === "POST") {
        requireScope(caller, "workflows:write");
        const value = await parseJson(request);
        const workflowType = value && typeof value === "object" && !Array.isArray(value)
          && typeof (value as Record<string, unknown>).workflowType === "string"
          ? (value as Record<string, unknown>).workflowType as string : "single-turn";
        const forecast = await env.ROUTING_STATE.getByName(caller.environment).workflowForecast(
          caller.environment, caller.id, workflowType,
        );
        const spec = parseWorkflowSpec(value, forecast.observations > 0 ? forecast : {});
        const id = crypto.randomUUID();
        const workflow = await env.WORKFLOW_COORDINATOR.getByName(id).create(
          id, caller.id, caller.environment, spec,
        );
        return Response.json({ ...workflow, planningForecast: forecast }, { status: 201 });
      }
      if (url.pathname.startsWith("/v1/workflows/") && request.method === "POST" && url.pathname.endsWith("/outcome")) {
        requireScope(caller, "workflows:write");
        const id = url.pathname.slice("/v1/workflows/".length, -"/outcome".length);
        const outcome = parseWorkflowOutcome(await parseJson(request));
        const workflow = await env.WORKFLOW_COORDINATOR.getByName(id).complete(id, caller.id, outcome);
        ctx.waitUntil(env.ROUTING_STATE.getByName(caller.environment).recordWorkflowOutcome({
          workflowId: workflow.id,
          completedAt: Date.now(),
          callerId: caller.id,
          environment: caller.environment,
          contextKey: `${workflow.workflowType}:${workflow.qualityTier}`,
          providerId: workflow.primaryProvider,
          modelId: workflow.primaryModel,
          success: outcome.success,
          quality: outcome.quality,
          validatorPassed: outcome.validatorPassed,
          deadlineMet: outcome.deadlineMet ?? (workflow.deadlineAt === undefined || Date.now() <= workflow.deadlineAt),
          callsCompleted: workflow.callsCompleted,
          actualTokens: workflow.actualTokens,
        }));
        return Response.json(workflow);
      }
      if (url.pathname.startsWith("/v1/workflows/") && request.method === "GET") {
        requireScope(caller, "workflows:read");
        const id = url.pathname.slice("/v1/workflows/".length);
        const workflow = await env.WORKFLOW_COORDINATOR.getByName(id).get(id, caller.id);
        return workflow ? Response.json(workflow) : openAiError("invalid_request", "Workflow not found", 404);
      }
      if (url.pathname === "/v1/routing/stats" && request.method === "GET") {
        requireScope(caller, "stats:read");
        return Response.json(await env.ROUTING_STATE.getByName(caller.environment).summary(caller.environment));
      }
      if (url.pathname === "/v1/routing/evaluation" && request.method === "GET") {
        requireScope(caller, "stats:read");
        return Response.json(await env.ROUTING_STATE.getByName(caller.environment).shadowEvaluation(caller.environment));
      }
      if (url.pathname === "/v1/routing/policy" && request.method === "GET") {
        requireScope(caller, "stats:read");
        return Response.json(await env.ROUTING_STATE.getByName(caller.environment).policyControl(
          caller.environment, defaultPolicyControl(env),
        ));
      }
      if (url.pathname === "/v1/routing/policy" && request.method === "PUT") {
        requireScope(caller, "policy:write");
        const value = await parseJson(request);
        if (!value || typeof value !== "object" || Array.isArray(value)) {
          throw new RouterError("invalid_request", "Policy control body must be an object.", 400);
        }
        const body = value as Record<string, unknown>;
        if (body.mode !== "baseline" && body.mode !== "shadow" && body.mode !== "adaptive") {
          throw new RouterError("invalid_request", "mode must be baseline, shadow, or adaptive.", 400);
        }
        if (typeof body.explorationRate !== "number" || body.explorationRate < 0 || body.explorationRate > 0.25) {
          throw new RouterError("invalid_request", "explorationRate must be between 0 and 0.25.", 400);
        }
        if (typeof body.minObservations !== "number" || !Number.isInteger(body.minObservations) || body.minObservations < 0) {
          throw new RouterError("invalid_request", "minObservations must be a non-negative integer.", 400);
        }
        return Response.json(await env.ROUTING_STATE.getByName(caller.environment).setPolicyControl(caller.environment, {
          mode: body.mode, explorationRate: body.explorationRate, minObservations: body.minObservations,
        }));
      }
      if (url.pathname === "/v1/jobs" && request.method === "POST") {
        requireScope(caller, "jobs:write");
        const generation = await parseGenerationRequest(request);
        if (generation.route?.allowPaid) requireScope(caller, "providers:paid");
        if (generation.stream) throw new RouterError("invalid_request", "Async jobs do not support streaming.", 400);
        const job = await env.ASYNC_JOB_QUEUE.getByName("default").fetch("https://queue/enqueue", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            request: generation, callerId: caller.id, environment: caller.environment,
            rateLimits: caller.rateLimits,
          }),
        }).then((response) => response.json<{ id: string; status: string; createdAt: number; updatedAt: number }>());
        return Response.json({ ...job, status_url: `/v1/jobs/${job.id}` }, { status: 202 });
      }
      if (url.pathname.startsWith("/v1/jobs/") && request.method === "GET") {
        requireScope(caller, "jobs:read");
        const id = url.pathname.slice("/v1/jobs/".length);
        const response = await env.ASYNC_JOB_QUEUE.getByName("default").fetch(
          `https://queue/jobs/${encodeURIComponent(id)}?callerId=${encodeURIComponent(caller.id)}`,
        );
        return response.status === 404 ? openAiError("invalid_request", "Job not found", 404) : response;
      }
      if (url.pathname === "/v1/chat/completions" && request.method === "POST") {
        requireScope(caller, "chat:write");
        const generation = await parseGenerationRequest(request);
        if (generation.route?.allowPaid) requireScope(caller, "providers:paid");
        return await executeGeneration(generation, env, (promise) => ctx.waitUntil(promise), {
          identity: { callerId: caller.id, environment: caller.environment, rateLimits: caller.rateLimits },
        });
      }
      return openAiError("invalid_request", "Not found", 404);
    } catch (error) {
      if (error instanceof RouterError) return openAiError(error.code, error.message, error.status, error.retryAfterMs);
      console.error("Unhandled router error", error);
      return openAiError("upstream_error", "Router failed while processing the request.", 500);
    }
  },
} satisfies ExportedHandler<Env>;

async function parseGenerationRequest(request: Request): Promise<GenerationRequest> {
  try {
    return await request.json<GenerationRequest>();
  } catch {
    throw new RouterError("invalid_request", "Request body must be valid JSON.", 400);
  }
}

async function parseJson(request: Request): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    throw new RouterError("invalid_request", "Request body must be valid JSON.", 400);
  }
}

function openAiError(code: string, message: string, status: number, retryAfterMs?: number): Response {
  const headers = new Headers({ "content-type": "application/json" });
  if (retryAfterMs) headers.set("retry-after", String(Math.ceil(retryAfterMs / 1_000)));
  return new Response(JSON.stringify({ error: { message, type: code, code } }), { status, headers });
}
