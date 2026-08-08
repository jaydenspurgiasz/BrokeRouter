# ADR 0001: Cloudflare-first deployment, portable routing core

**Status:** Accepted

## Context

BrokeRouter must make low-latency LLM calls for a Cloudflare-hosted agent today, while remaining able to move to another serverless runtime and support more API providers later. NVIDIA's free endpoint does not guarantee that quota balance can always be queried exactly, so concurrent agent calls must not independently decide that capacity exists.

## Decision

Use a native Fetch/Streams Cloudflare Worker as the first gateway runtime and invoke it from the agent over a Service Binding. Use a SQLite-backed Durable Object keyed by provider credential scope solely to reserve budget, reconcile outcomes, and persist provider cooldown. The Worker calls the provider directly and passes through the upstream body immediately; it does not send stream data through the Durable Object or store prompts/responses.

Define model capabilities and routing types in `src/core`, provider invocation in `src/providers`, and Cloudflare-specific coordination in `src/adapters/cloudflare`. Keep the repository single-package until a second runtime or consumer needs publishing; then extract the already-isolated core rather than prematurely maintaining a monorepo.

## Consequences

The first call adds one small coordinator RPC before the upstream call, in exchange for atomic free-budget reservations across concurrent agents. Generation streaming remains limited chiefly by the provider's time-to-first-token. A shared NVIDIA key maps to a shared coordinator object, so high traffic may eventually require credential pools or a different quota strategy. The router never silently truncates context; it rejects unsupported requests and leaves compaction to the calling agent.
