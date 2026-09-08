# Architecture

```text
Cloudflare Agent --Service Binding---> Gateway Worker --HTTPS--> Provider API
Local Agent --Cloudflare Access------>       |
                                               +--RPC--> environment/credential-pool Routing Coordinator
                                               +--RPC--> workflow-ID Coordinators (SQLite shards)
                                               +--async RPC--> environment Routing State (telemetry + evaluation)
```

The public HTTP surface and Service-Binding surface use the same handler and independently revocable caller credentials. The personal MVP uses its `workers.dev` endpoint; a custom hostname protected by Cloudflare Access is a compatible defense-in-depth upgrade.

For each request the gateway authenticates and authorizes the caller and filters models through non-negotiable capability/context gates. It then makes one RPC to the routing environment's credential-pool coordinator. In one SQLite transaction, that coordinator inspects every provider's predictive request/token buckets, concurrent reservations, daily budget, and cooldowns; ranks only providers that pass; and reserves the winner. If none can admit, the Worker waits only for a bounded interactive window and otherwise returns `503` with `Retry-After`. Success and failure reconciliation is scheduled with `waitUntil`, so it does not delay SSE bytes.

When a workflow ID is present, its dedicated Workflow Coordinator replaces untrusted routing hints with durable remaining calls, tokens, concurrency, deadline, quality tier, and provider affinity. It atomically leases a workflow call only after provider capacity is reserved. Stream completion or cancellation reconciles the provider reservation, workflow lease, and routing outcome exactly once. Durable alarms fail missed deadlines and feed that outcome into learning even without a polling client. Unrelated workflows never contend on one global Durable Object.

The latency-critical Routing Coordinator stores quota state plus a compact replica of hierarchical online-policy statistics. Environment-sharded Routing State receives decisions and outcomes asynchronously for durable telemetry, forecasts, and offline evaluation. Baseline and shadow modes are deterministic. Adaptive mode uses bounded epsilon-greedy exploration only among gate-approved candidates and logs exact propensities for offline evaluation.

## Server and distributed-systems concerns

BrokeRouter is intentionally more than an API wrapper. Its server-side engineering surface includes:

- **Protocol boundary:** one authenticated OpenAI-compatible HTTP/SSE API normalizes heterogeneous upstreams.
- **Admission and backpressure:** strongly consistent request/token buckets, concurrency leases, predictive retry times, bounded inline waiting, durable deferred work, and explicit `429`/`503` behavior.
- **State ownership:** provider credentials that compete in one routing decision share an environment/credential-pool coordination atom; callers, workflows, queues, and analytical telemetry retain separate shard keys. A larger deployment can shard routing coordinators by independent credential pool.
- **Failure recovery:** reservation TTLs recover abandoned calls, upstream failures open persisted cooldowns, stream cancellation reconciles exactly once, alarms advance jobs and deadlines without a client connection, and policy rollback is independent of deployment.
- **Security:** Cloudflare Access authenticates the transport; hashed, scoped, independently revocable caller credentials authenticate the application; provider secrets remain server-side; Service Bindings keep Cloudflare-to-Cloudflare traffic off the public path.
- **Operations:** the personal deployment owns one authoritative state plane, migrations are versioned, CI performs type/tests/bundle checks, deployment is manual, and local/deployed benchmarks publish percentiles, saturation curves, errors, provider distribution, colo distribution, and decision/outcome integrity. The logical environment key remains a future isolation seam without requiring duplicate infrastructure today.

That framing is the project's strongest systems story: a multi-tenant-style control plane built for one owner today, with explicit consistency boundaries, overload behavior, observability, safe rollout, and horizontal-sharding seams.
