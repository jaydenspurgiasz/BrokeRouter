# BrokeRouter — Project and Resume Brief

This document gives a reader with no prior project context the technical, architectural, and
benchmark information needed to understand and present BrokeRouter accurately.

## Project summary

**BrokeRouter** is a provider-agnostic, free-tier-aware LLM routing gateway for agentic workloads.
It exposes an OpenAI-compatible API and automatically chooses among available LLM providers based
on model capabilities, quota availability, workflow requirements, and learned provider behavior.

The initial deployment runs on Cloudflare Workers and integrates NVIDIA API Catalog and Google
Gemini. The provider interface supports additional OpenAI-compatible services without coupling the
routing core to NVIDIA, Gemini, or Cloudflare.

The name is a joke about maximizing free-tier capacity. Technically, BrokeRouter is a routing
gateway, distributed admission-control system, durable job server, and constrained online
allocation system.

- Repository: <https://github.com/jaydenspurgiasz/BrokeRouter>
- Local project: `C:\Users\spurg\Documents\Projects\BrokeRouter`
- Production Worker: `https://broke-router.jaydenspurgiasz.workers.dev`

Never include production credentials, provider keys, caller tokens, or secret registry values in
public documentation or resume material.

## Problem being solved

Agentic workflows create bursty, heterogeneous demand. One workflow might need a single inexpensive
LLM call, while another needs five calls with several running concurrently. Greedily assigning both
to the currently best provider can exhaust a scarce free tier and prevent the larger workflow from
finishing.

BrokeRouter treats routing as a constrained online allocation problem:

> Select the best eligible provider while preserving scarce capacity for future workflows,
> maintaining hard safety invariants, and learning from observed outcomes.

The decision system has two layers:

1. **Hard safety gates.** These run first and cannot be overridden. They enforce authentication,
   authorization, provider capabilities, context preservation, free-only restrictions, request and
   token limits, daily budgets, concurrency, cooldowns, and workflow limits.
2. **Optimization policy.** When multiple providers pass all gates, an explainable or learned policy
   ranks the candidates.

This prevents an adaptive policy from violating financial or operational constraints.

## Primary use case

A personal collection of agents calls one authoritative Cloudflare-hosted router. Callers can
include Cloudflare-hosted agents, a local laptop, interactive applications, multi-call workflows,
and deferred jobs. Sharing one authoritative state plane prevents local and cloud agents from
double-counting provider capacity or learning incompatible policies.

## Technology stack

- TypeScript
- Cloudflare Workers
- Cloudflare Durable Objects
- SQLite-backed Durable Object storage
- Fetch and Streams APIs
- Server-Sent Events for streaming
- Durable Object alarms for delayed jobs and workflow deadlines
- NVIDIA API Catalog
- Google Gemini through its OpenAI-compatible endpoint
- Generic OpenAI-compatible provider adapter
- Vitest, TypeScript, Wrangler, and custom integration/benchmark harnesses

Cloudflare Workers provide serverless execution near callers. Durable Objects provide strongly
consistent coordination for shared quota reservations. SQLite-backed storage supplies atomic local
transactions without operating a separate database server. TypeScript is suitable because
production timing shows that routing computation itself is negligible; network coordination and
provider inference dominate latency.

## API surface

### Interactive completions

```http
POST /v1/chat/completions
```

OpenAI-compatible synchronous and streaming endpoint. Clients normally request a logical model:

```json
{
  "model": "free/default",
  "messages": [{ "role": "user", "content": "Explain Durable Objects." }]
}
```

The client does not need to choose NVIDIA or Gemini; BrokeRouter routes automatically.

### Model catalog

```http
GET /v1/models
```

Returns logical and provider-specific models with capability metadata.

### Asynchronous jobs

```http
POST /v1/jobs
GET /v1/jobs/{id}
```

Used for noninteractive work that should remain queued until capacity becomes available. Jobs are
persisted, alarm-driven, caller-scoped, retryable, and pollable without holding an HTTP connection.

### Workflows

```http
POST /v1/workflows
GET /v1/workflows/{id}
POST /v1/workflows/{id}/outcome
```

Workflows describe expected calls, maximum calls, maximum concurrency, estimated total tokens,
quality tier, deadline, and priority. The server owns the durable workflow budget; untrusted request
fields cannot overwrite it.

### Policy and telemetry

```http
GET /v1/routing/stats
GET /v1/routing/evaluation
GET /v1/routing/policy
PUT /v1/routing/policy
```

These endpoints expose routing telemetry, offline policy evaluation, and immediate policy-mode
control.

### Health

```http
GET /health
```

## Authentication and security

The service is intended to be private. Each caller has an independently revocable token whose
authenticated record provides its identity, environment, scopes, and optional caller rate limits.
Only SHA-256 token hashes are stored in the encrypted Cloudflare secret registry.

Scopes include `chat:write`, `models:read`, `jobs:write`, `jobs:read`, `workflows:write`,
`workflows:read`, `stats:read`, `policy:write`, and `providers:paid`.

Provider keys and caller registries are Cloudflare Worker secrets. Routing telemetry deliberately
does not store prompts, completions, private reasoning, or provider credentials.

## Request path

```text
Authenticate and authorize caller
    ↓
Apply server-owned workflow context
    ↓
Filter models through hard capability and context gates
    ↓
Atomic plan-and-reserve coordinator RPC
    ├── Expire abandoned reservations
    ├── Inspect every provider's quota state
    ├── Apply request/token/daily/concurrency/cooldown gates
    ├── Read compact online-policy statistics
    ├── Rank eligible providers
    └── Reserve the winner atomically
    ↓
Invoke the provider from the Worker
    ↓
Validate and normalize JSON or streaming SSE
    ↓
Return the response
    ↓
Reconcile quota, telemetry, and learning asynchronously
```

Provider network calls stay outside the Durable Object. This prevents slow inference from occupying
the coordination object.

## Admission control and rate limiting

BrokeRouter accounts for several provider limits simultaneously:

- **Request rate:** persisted token buckets predict the next request slot.
- **Token rate:** separate buckets reserve estimated input plus maximum requested output.
- **Daily budget:** actual consumption and active reservations count against a local safety ceiling.
- **Concurrency:** accepted calls acquire leases, preventing excess simultaneous generations.
- **Cooldown:** provider `429` responses and upstream failures can open persisted cooldowns.
- **Recovery:** reservation TTLs eventually release capacity abandoned by a crash or lost request.
- **Bounded interactive waiting:** short predicted delays may wait up to `MAX_INLINE_WAIT_MS`.
- **Durable queuing:** longer waits use the asynchronous jobs API and alarms.
- **Automatic failover:** failures, rate limits, and semantically invalid completions can retry through
  another eligible provider.

Provider-supplied retry/reset information takes precedence over local predictions.

## Workflow-aware optimization

The deterministic baseline is a best-fit allocation policy. It asks whether the entire expected
workflow can fit across remaining request capacity, token capacity, daily capacity, and concurrency.

For a small one-call request, it prefers the smallest provider quota that safely fits, preserving
larger free tiers for future multi-call workflows. For a larger workflow, it prefers a provider with
enough aggregate and concurrent headroom. This resembles multidimensional bin packing under
uncertain future demand.

## Adaptive routing

BrokeRouter maintains hierarchical Bayesian-style provider statistics at global, workflow/context,
and caller-context scopes. Signals include:

- Success probability
- Workflow-completion probability
- Rate-limit risk
- Latency EWMA
- Token-use EWMA
- Quality feedback
- Observation count and uncertainty

The learned score adjusts the deterministic baseline using posterior success, completion
likelihood, quality, rate-limit risk, latency, and an uncertainty bonus.

Policy modes:

- **Baseline:** deterministic best-fit only.
- **Shadow:** serves baseline decisions while logging what the learned policy would choose.
- **Adaptive:** serves learned rankings with bounded epsilon-greedy exploration.

Exploration occurs only among candidates that passed every hard gate. Exact propensities are logged
for Inverse Propensity Scoring, Self-Normalized IPS, and effective-sample-size analysis. Policy mode
can be rolled back without redeployment.

## Durable workflows

Workflow state includes remaining calls, maximum concurrency, estimated and actual token usage,
deadline, provider/model affinity, active leases, and terminal quality feedback. The Workflow
Coordinator atomically leases calls after provider capacity is reserved. Completion, cancellation,
failure, and deadline expiration reconcile state exactly once. Alarms fail expired workflows even
without a polling client. Outcomes update learned call-count and token forecasts.

## Response correctness

HTTP 200 is not automatically considered success. BrokeRouter verifies that a provider response
contains visible assistant content, a refusal, tool calls, or a function call. Empty or truncated
responses are recorded as failures and may trigger fallback.

Private provider reasoning fields are removed from JSON and streaming SSE. This addresses a real
NVIDIA behavior where the model could spend its output allowance on reasoning and return
`content: null`.

## Production latency investigation

### Original problem

The original hot path awaited three sequential Durable Object RPCs:

```text
Provider quota inspection
    ↓
Policy-state lookup
    ↓
Provider quota reservation
```

Production phase measurements were:

| Phase | Mean latency |
| --- | ---: |
| Provider quota inspection | 90.65 ms |
| Policy-state lookup | 64.25 ms |
| Provider quota reservation | 113.95 ms |
| **Total** | **268.85 ms** |

Routing computation, workflow work, normalization, and unattributed work all rounded to zero. The
three network phases summed exactly to measured BrokeRouter time, proving that the bottleneck was the
distributed coordination topology rather than TypeScript or policy math.

### Architectural correction

A SQLite-backed `RoutingCoordinator` now performs one `planAndReserve()` RPC. In one transaction it:

1. Inspects all provider limits.
2. Applies all admission gates.
3. Reads compact online-policy state.
4. Ranks passing candidates.
5. Reserves the winner.

The coordinator is sharded by routing environment/credential pool instead of using one universal
object. A versioned object name forced fresh instantiation, and a best-effort Western North America
location hint was supplied. Provider inference remains outside the coordinator.

## Benchmark methodology

The deployed benchmark uses an authenticated, explicit `benchmark/echo` provider. It traverses the
real server path without consuming LLM quota.

It includes client networking, Cloudflare ingress/egress, Worker authentication, gates, Durable
Object RPC, SQLite, quota admission, policy evaluation, reservation, telemetry, JSON normalization,
and streaming SSE. It excludes real model inference for synthetic throughput measurements.

Default load shape:

- 40 requests per run
- Three repeats
- Concurrency 1, 4, 8, and 16
- 480 synthetic server-path requests
- p50, p95, and p99 latency
- Error rate and streaming time to first token
- Per-phase `Server-Timing` decomposition
- Decision/outcome telemetry reconciliation

Optional real-provider calls separately measure NVIDIA/Gemini latency.

## Production benchmark results

### Before the coordination redesign

```text
Peak successful synthetic server path: 32.14 req/s @ concurrency 16
Latency: p50 408.54 ms | p95 469.46 ms | p99 472.96 ms
BrokeRouter p50: 265 ms
BrokeRouter mean: 268.85 ms
Errors: 0/480
```

### After single-hop coordination

```text
Peak successful synthetic server path: 128.65 req/s @ concurrency 16
Latency: p50 98.54 ms | p95 141.71 ms | p99 145.47 ms
Streaming TTFT: p50 88.67 ms | p95 95.71 ms
Errors: 0/480
Telemetry: +566 decisions / +566 outcomes
```

### Improvement

| Metric | Before | After | Change |
| --- | ---: | ---: | ---: |
| Synthetic deployed gateway throughput | 32.14 req/s | 128.65 req/s | **4.0×** |
| Synthetic server-path p50 | 408.54 ms | 98.54 ms | **75.9% lower** |
| BrokeRouter p50 | 265 ms | 73 ms | **72.5% lower** |
| BrokeRouter mean | 268.85 ms | 74 ms | **72.5% lower** |
| Errors | 0/480 | 0/480 | Remained zero |

Post-redesign phase timing:

```text
Atomic plan + reserve RPC:
mean 74.00 ms
p50  73.00 ms
p95  80.05 ms
p99  80.81 ms
```

Every other measured router phase rounded to zero. The remaining router time is principally one
strongly consistent Worker-to-Durable-Object round trip, not application CPU time.

### Real-provider sample after optimization

| Component | Mean | p50 | p95 | p99 |
| --- | ---: | ---: | ---: | ---: |
| End-to-end | 774.51 ms | 475.21 ms | 2208.37 ms | 3009.72 ms |
| LLM provider round trip | 657.35 ms | 344.50 ms | 2057.00 ms | 2908.20 ms |
| BrokeRouter only | 74.00 ms | 73.00 ms | 80.05 ms | 80.81 ms |
| Client + Cloudflare | 43.16 ms | 21.08 ms | 107.18 ms | 136.78 ms |

The remaining tail latency is overwhelmingly provider-side; BrokeRouter's own distribution is
comparatively tight.

### Claim boundary

Do **not** claim that BrokeRouter performs 129 real LLM inferences per second. The 128.65 req/s result
measures the deployed gateway/control-plane path with a synthetic provider. Resume wording should
say “synthetic deployed gateway throughput,” “deployed routing path,” or “control-plane throughput.”

## Verification completed

- TypeScript compiler passes.
- 27/27 unit tests pass.
- Wrangler bundle and deployment dry run pass.
- Durable Object bindings and migration `v4` validate.
- Isolated Worker integration benchmark passes.
- Automatic NVIDIA-to-Gemini fallback test passes.
- Caller-specific rate-limit test passes.
- Streaming sanitization and semantic completion tests pass.
- Deployed benchmark completed 480/480 requests without error.
- Telemetry decisions and outcomes reconcile exactly.

## Engineering concepts demonstrated

- Strongly consistent distributed admission control
- Atomic quota reservations
- Multidimensional rate limiting and predictive token buckets
- Backpressure, bounded waiting, and durable deferred work
- Leases, expiration, crash recovery, and idempotent reconciliation
- Explicit state ownership and consistency domains
- Stateful serverless coordination and transactional SQLite
- SSE lifecycle and cancellation handling
- Failure-aware multi-provider failover
- Phase-level production observability and tail-latency analysis
- Online policy learning and off-policy evaluation
- Safety-constrained exploration
- Authentication, authorization, and secret management
- Provider abstraction and protocol normalization
- Horizontal-sharding seams
- Architecture-driven performance optimization

## Resume positioning

The strongest description is:

> A strongly consistent, serverless admission-control and online optimization system for
> heterogeneous LLM capacity.

Do not present it primarily as an application that calls NVIDIA and Gemini. The compelling systems
story is that production telemetry isolated a distributed coordination bottleneck, the state and
consistency boundary was redesigned, and the result was a measured 4× throughput increase and 72.5%
routing-latency reduction without sacrificing quota correctness.

For quant or optimization roles, emphasize constrained online allocation, multidimensional capacity,
future-demand preservation, hierarchical Bayesian statistics, exploration versus exploitation,
propensity logging, IPS/SNIPS, effective sample size, workflow-completion objectives, and regret.

## Recommended resume entry

### General software and systems version

**BrokeRouter — Adaptive Serverless LLM Routing Gateway**
*TypeScript, Cloudflare Workers, Durable Objects, SQLite, Vitest*

- Built an OpenAI-compatible, provider-agnostic LLM control plane with predictive request/token
  scheduling, atomic quota admission, concurrency leases, durable asynchronous jobs, streaming, and
  automatic provider failover.
- Re-architected three sequential distributed coordination calls into one atomic SQLite-backed
  transaction, reducing deployed routing p50 latency **72.5% (265→73 ms)** and increasing synthetic
  gateway throughput **4.0× (32→129 req/s)** with **0/480 errors**.
- Designed workflow-aware allocation that preserves scarce capacity for multi-call and concurrent
  agent workloads while enforcing capability, context, daily-budget, cooldown, and free-only gates.
- Implemented hierarchical online provider statistics, bounded exploration, exact propensity
  logging, and IPS/SNIPS shadow-policy evaluation with immediate rollback.

### Concise two-bullet version

**BrokeRouter — Serverless LLM Routing and Admission Control**

- Built a strongly consistent, provider-agnostic LLM gateway on Cloudflare Workers and SQLite-backed
  Durable Objects with multidimensional quota scheduling, concurrency leases, automatic failover,
  streaming, durable jobs, and authenticated caller isolation.
- Consolidated three coordination round trips into one atomic transaction, cutting deployed routing
  p50 **72.5% (265→73 ms)** and improving synthetic control-plane throughput **4× (32→129 req/s)**
  with **0/480 errors**.

### Quant-focused version

**BrokeRouter — Constrained Online Allocation for Agentic LLM Workloads**

- Developed a gate-constrained contextual routing policy that allocates bursty, multi-call workflows
  across rate-limited providers using expected calls, concurrency, token demand, quality, latency,
  quota headroom, and posterior reliability.
- Added hierarchical Bayesian statistics, epsilon-greedy exploration, exact propensity logging, and
  IPS/SNIPS evaluation while preventing learned policies from overriding capability, budget,
  cooldown, concurrency, or context-preservation constraints.
- Redesigned the strongly consistent coordination path from three RPCs to one atomic transaction,
  producing a **72.5% p50 latency reduction** and **4× deployed gateway-throughput improvement**.

## Interview explanation

> I built BrokeRouter because agentic workflows create bursty LLM demand and free-tier providers
> have different request, token, daily, and concurrency limits. The gateway exposes an
> OpenAI-compatible API, applies hard safety and capability gates, then selects among eligible
> NVIDIA, Gemini, or other OpenAI-compatible providers. It maintains predictive token buckets,
> durable reservations, cooldowns, workflow budgets, and an online policy that learns provider
> reliability and latency. During production benchmarking I found that routing math took effectively
> zero milliseconds, but three sequential Durable Object RPCs added about 269 milliseconds. I
> changed the coordination atom so provider inspection, policy lookup, selection, and reservation
> occur in one SQLite transaction. That cut router p50 from 265 to 73 milliseconds and increased the
> deployed synthetic gateway path from 32 to 129 requests per second with zero errors across 480
> requests.

## Interview questions and answers

### Why not keep quota state in Worker memory?

Cloudflare may run multiple isolates and regions. In-memory counters would race, disappear on
eviction or deployment, and allow concurrent agents to overspend shared limits. Durable Objects
provide a strongly consistent coordination point.

### Why not PostgreSQL?

At the current scale, each hot-path decision belongs to a small coordination atom. SQLite-backed
Durable Objects provide transactional state without another database network hop or separate server.
PostgreSQL could later support cross-shard analytics or a larger shared service, but would not
automatically improve the critical coordination path.

### Why one routing coordinator instead of one object per provider?

The policy must compare several providers and reserve exactly one winner. Separate objects required
multiple inspection and reservation round trips. Providers participating in the same decision
therefore share one coordination atom. Independent credential pools can be sharded later.

### Is the coordinator a bottleneck?

It can become one at sufficiently high scale, so the design shards by routing environment or
credential pool instead of using one universal object. Provider inference remains outside the
coordinator, which performs only small SQLite transactions.

### Why does approximately 73 ms remain?

Routing computation itself rounds to zero. Most remaining time is the Worker-to-Durable-Object
network round trip. Exact global quota enforcement across independent isolates requires coordination
and therefore cannot be literally zero latency.

### Why TypeScript instead of Rust?

The path is dominated by network coordination and model inference. Production telemetry shows that
the routing computation rounds to zero milliseconds, so changing languages would not materially
improve end-to-end latency. Eliminating distributed round trips produced the meaningful speedup.

### How does the learned policy avoid overspending?

Learning runs only after hard gates. The policy never receives candidates that violate cost, quota,
context, capability, concurrency, or cooldown requirements. Selection and reservation are atomic.

### What if a provider returns HTTP 200 without an answer?

The semantic response gate requires visible content, a refusal, or tool/function calls. Empty or
truncated completions are recorded as failures and can trigger fallback.

### How was the optimization verified?

`Server-Timing` decomposes provider, router, total Worker, client/Cloudflare, and individual routing
phases. Before the redesign, three RPC phases summed exactly to router time. Afterward, one
coordinator RPC accounts for the hot path and router p50 fell from 265 to 73 ms.

## Honest limitations

- Production use is currently personal-scale.
- The 129 req/s result is synthetic gateway throughput, not real inference throughput.
- The learned policy needs more real multi-provider outcomes before claiming statistically
  significant quality or regret improvements.
- One coordinator per environment/credential pool needs further sharding for a large public service.
- Location-sensitive Durable Object latency remains about 73 ms p50 in the latest production sample.
- Provider limits can be undocumented or dynamic, so local configurations are conservative
  predictions corrected by observed upstream signals.
- The router does not own agent memory, history, prompt compaction, or tool execution.
- The generic abstraction is strongest for OpenAI-compatible providers; substantially different
  protocols require adapters.
- A polished dashboard and long-duration production study are still future work.

## Highest-value next improvements

1. Build a deterministic routing simulator comparing round robin, greedy routing, largest-quota
   first, best fit, adaptive routing, and an oracle policy.
2. Track workflow completion, quality-adjusted completion, free-token utilization, provider
   rejection, deadline success, allocation regret, quota fragmentation, tail latency, failover rate,
   and cost avoided.
3. Add fault injection for reservation races, `429` storms, timeouts, malformed responses, stream
   cancellation, post-reservation crashes, duplicate outcomes, alarms, and provider recovery.
4. Build a live dashboard for provider capacity, predicted slots, routing explanations,
   reservations, posteriors, policy mode, shadow decisions, workflows, latency, regret, and
   utilization.
5. Collect several weeks of real traffic and publish confidence intervals, effective sample size,
   provider drift, workflow-completion changes, and free-tier capacity captured.
6. Compare newly instantiated `wnam` and `enam` coordinators with identical benchmarks to test
   whether the remaining coordination RTT is placement-related.
7. Add statistically defensible benchmark-regression budgets to CI.
8. Publish an architecture write-up showing the original topology, phase evidence, consistency
   redesign, measured result, correctness trade-offs, and scaling path.

## Instructions for anyone producing resume material

- Lead with the distributed-systems problem and measured architectural improvement.
- Use the exact before-and-after metrics.
- Explicitly identify 128.65 req/s as synthetic deployed gateway/control-plane throughput.
- Never describe it as real LLM inference throughput.
- Emphasize admission control, online allocation, observability, and fault recovery.
- For general SWE roles, prioritize architecture and latency investigation.
- For infrastructure roles, prioritize consistency, leases, queues, streaming, and state ownership.
- For quant roles, prioritize constrained allocation, Bayesian statistics, exploration, propensities,
  IPS/SNIPS, and regret.
- Do not disclose secrets or private tokens.
- Do not claim that the learned policy has already beaten all baselines on statistically significant
  real-world traffic; that study has not yet been completed.
- Present BrokeRouter as a distributed server and optimization system, not merely an LLM wrapper.
