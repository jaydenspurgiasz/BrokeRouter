# Architecture

```text
Cloudflare Agent --Service Binding---> Gateway Worker --HTTPS--> Provider API
Local Agent --Cloudflare Access------>       |
                                               +--RPC--> credential-scoped Quota Coordinators
                                               +--RPC--> workflow-ID Coordinators (SQLite shards)
                                               +--RPC--> environment Routing State (SQLite + online posteriors)
```

The public HTTP surface and Service-Binding surface use the same handler and independently revocable caller credentials. The custom public hostname is protected by Cloudflare Access; `workers.dev` remains disabled.

For each request the gateway authenticates and authorizes the caller, filters models through non-negotiable capability/context gates, and concurrently inspects every candidate credential coordinator. Only providers passing admission gates reach the versioned routing policy. The router atomically reserves the policy winner and falls through to the next ranked candidate if it loses a race. Admission accounts for predictive request/token buckets, concurrent reservations, daily budget, and cooldowns. If none can admit, it waits only for a bounded interactive window and otherwise returns `503` with `Retry-After`. Success and failure reconciliation is scheduled with `waitUntil`, so it does not delay SSE bytes.

When a workflow ID is present, its dedicated Workflow Coordinator replaces untrusted routing hints with durable remaining calls, tokens, concurrency, deadline, quality tier, and provider affinity. It atomically leases a workflow call only after provider capacity is reserved. Stream completion or cancellation reconciles the provider reservation, workflow lease, and routing outcome exactly once. Durable alarms fail missed deadlines and feed that outcome into learning even without a polling client. Unrelated workflows never contend on one global Durable Object.

Environment-sharded Routing State stores metadata-only decisions and outcomes, hierarchical provider statistics, and policy control. Baseline and shadow modes are deterministic. Adaptive mode uses bounded epsilon-greedy exploration only among gate-approved candidates and logs exact propensities for offline evaluation.
