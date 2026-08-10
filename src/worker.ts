import type { Env } from "./config";
import { executeGeneration } from "./adapters/cloudflare/execution";
import { registeredProviders } from "./adapters/cloudflare/provider-registry";
import { QuotaCoordinator } from "./adapters/cloudflare/quota-coordinator";
import { AsyncJobQueue } from "./adapters/cloudflare/async-job-queue";
import { authenticateCaller, requireScope } from "./core/auth";
import { RouterError, type GenerationRequest } from "./core/types";

export { QuotaCoordinator, AsyncJobQueue };
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
      if (url.pathname === "/v1/jobs" && request.method === "POST") {
        requireScope(caller, "jobs:write");
        const generation = await parseGenerationRequest(request);
        if (generation.route?.allowPaid) requireScope(caller, "providers:paid");
        if (generation.stream) throw new RouterError("invalid_request", "Async jobs do not support streaming.", 400);
        const job = await env.ASYNC_JOB_QUEUE.getByName("default").fetch("https://queue/enqueue", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ request: generation, callerId: caller.id }),
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
        return await executeGeneration(generation, env, (promise) => ctx.waitUntil(promise));
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

function openAiError(code: string, message: string, status: number, retryAfterMs?: number): Response {
  const headers = new Headers({ "content-type": "application/json" });
  if (retryAfterMs) headers.set("retry-after", String(Math.ceil(retryAfterMs / 1_000)));
  return new Response(JSON.stringify({ error: { message, type: code, code } }), { status, headers });
}
