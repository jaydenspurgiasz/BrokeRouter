# ADR 0005: Single-hop routing coordination

## Status

Accepted. Supersedes the provider-admission topology in ADRs 0001–0003; their safety and data-minimization requirements remain in force.

## Context

Production phase timing showed that routing computation rounded to zero milliseconds, while three
sequential Durable Object RPCs consumed roughly 269 ms per request: provider inspection, policy-state
lookup, and provider reservation. The mean of those phases exactly equaled measured BrokeRouter time.
Strong quota consistency requires coordination, but three geographically independent round trips do
not.

## Decision

Create one SQLite-backed `RoutingCoordinator` per routing environment/credential pool. A single
`planAndReserve` RPC receives only model, workflow, caller, quota, and capability metadata. Inside one
synchronous SQLite transaction it:

1. expires abandoned reservations and computes every provider's admission snapshot;
2. applies cooldown, daily-budget, token-bucket, request-bucket, and concurrency gates;
3. reads compact hierarchical policy statistics and policy control;
4. ranks the gate-approved candidates; and
5. reserves the winning credential before returning it.

The Worker invokes the selected provider directly. Prompts, completions, reasoning, secrets, and
provider network I/O never enter the coordinator. Quota reconciliation and the coordinator's compact
learning update are delivered with `waitUntil`; the existing Routing State object remains the
append-only telemetry, workflow-forecast, and offline-evaluation plane.

The coordinator uses a versioned object name and a best-effort Western North America location hint.
Because Cloudflare location hints only affect first instantiation, the versioned name prevents reuse
of objects placed by earlier VPN or test traffic.

## Consequences

- Provider admission, policy selection, and reservation require one strong-consistency RPC instead
  of three sequential RPCs.
- Providers participating in the same decision intentionally share a serialization boundary. This
  is the correct coordination atom for cross-provider quota optimization at personal scale.
- Independent credential pools can be horizontally sharded later without changing the routing core.
- Caller-specific quotas and workflow leases remain separate because they are optional, independent
  consistency domains.
- Deployment migration `v4` starts fresh provider quota and compact policy state. The prior analytical
  Routing State remains available, but it is not synchronously imported into the new hot path.
