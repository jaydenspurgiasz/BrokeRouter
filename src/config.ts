import type { AsyncJobQueue } from "./adapters/cloudflare/async-job-queue";
import type { QuotaCoordinator } from "./adapters/cloudflare/quota-coordinator";
import type { RoutingState } from "./adapters/cloudflare/routing-state";
import type { WorkflowCoordinator } from "./adapters/cloudflare/workflow-coordinator";

/** Runtime bindings shared by the Worker and its Durable Objects. */
export interface Env {
  NVIDIA_API_KEY: string;
  NVIDIA_ENABLED?: string;
  /** Enables an explicit, non-automatic deterministic model for deployed server benchmarks. */
  BENCHMARK_PROVIDER_ENABLED?: string;
  /** Preferred multi-caller registry. Store as an encrypted Worker secret. */
  CALLER_CREDENTIALS_JSON?: string;
  /** Transitional single-key authentication for local development only. */
  ROUTER_API_KEY?: string;
  NVIDIA_DAILY_SAFETY_BUDGET_TOKENS?: string;
  NVIDIA_COOLDOWN_MS?: string;
  NVIDIA_REQUESTS_PER_WINDOW?: string;
  NVIDIA_REQUEST_WINDOW_MS?: string;
  NVIDIA_TOKENS_PER_WINDOW?: string;
  NVIDIA_TOKEN_WINDOW_MS?: string;
  NVIDIA_MAX_CONCURRENT?: string;
  NVIDIA_RESERVATION_TTL_MS?: string;
  MAX_INLINE_WAIT_MS?: string;
  ASYNC_JOB_MAX_ATTEMPTS?: string;
  ASYNC_JOB_RETENTION_MS?: string;
  ROUTING_EVENT_RETENTION_MS?: string;
  WORKFLOW_RETENTION_MS?: string;
  ROUTING_POLICY_MODE?: string;
  ADAPTIVE_EXPLORATION_RATE?: string;
  ADAPTIVE_MIN_OBSERVATIONS?: string;
  ADDITIONAL_OPENAI_COMPATIBLE_PROVIDERS_JSON?: string;
  QUOTA_COORDINATOR: DurableObjectNamespace<QuotaCoordinator>;
  CALLER_QUOTA_COORDINATOR: DurableObjectNamespace<QuotaCoordinator>;
  ASYNC_JOB_QUEUE: DurableObjectNamespace<AsyncJobQueue>;
  ROUTING_STATE: DurableObjectNamespace<RoutingState>;
  WORKFLOW_COORDINATOR: DurableObjectNamespace<WorkflowCoordinator>;
}
