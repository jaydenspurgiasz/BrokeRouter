# ADR 0003: Gated contextual routing and a shared control plane

> Personal-MVP update: the single authoritative Worker initially uses its authenticated
> `workers.dev` URL. The Access-protected custom hostname described below is retained as the
> defense-in-depth target once a custom domain is worthwhile.

- Status: accepted
- Date: 2026-08-09

## Context

BrokeRouter is called by personal agents running both in Cloudflare Workers and on a local laptop. Those callers may use the same provider credentials, so independent routers would double-count available quota, race one another, and learn incompatible policies. Workflows also differ: one may need one call while another needs five concurrent calls and should be assigned to a provider with enough remaining capacity.

The router will eventually learn from outcomes. A learned decision must never override security, provider capabilities, free-only policy, context preservation, quotas, cooldowns, or concurrency controls.

## Decision

Production uses one authoritative Cloudflare-hosted control plane. Cloudflare agents reach it through Service Bindings. Local production agents reach an Access-protected custom hostname. Every caller also presents an independently revocable BrokeRouter credential whose authenticated record supplies its identity, environment, and scopes.

The decision pipeline is strictly ordered:

1. Authenticate and authorize the caller.
2. Validate and normalize the request.
3. Apply capability, context, spend, and safety gates.
4. Concurrently inspect credential-scoped provider availability.
5. Remove every provider that fails a hard gate.
6. Rank only the remaining providers with a versioned policy.
7. Atomically reserve the winner; try the next ranked candidate if a race is lost.
8. Execute and record outcomes.

The initial policy is an explainable deterministic best-fit optimizer. It accounts for expected workflow calls, tokens, and concurrency. A future Bayesian contextual policy will implement bounded exploration and partial pooling across callers and workflow types. It will first run in shadow mode and cannot bypass the gate interface.

Provider quota state remains in one Durable Object SQLite database per provider credential scope. A later singleton routing-state Durable Object will hold metadata-only decision events and online statistics. Raw prompts, completions, reasoning traces, and secrets are not learning data.

Local Wrangler instances use isolated development state. Production SQLite is not synchronized to a laptop; local production callers use the deployed router.

## Consequences

- All callers using a provider credential share correct quota, cooldown, queue, and reservation state.
- Sparse observations can be pooled while caller and workflow context prevent false equivalence.
- Availability inspection adds one Durable Object hop, but providers are inspected concurrently.
- Inspection and reservation are deliberately separate. Atomic reservation and ordered fallback close the race between them.
- Cloudflare Access protects the public transport; BrokeRouter credentials still identify and authorize applications.
- The policy is replaceable and measurable without weakening hard constraints.
- Migrating learning events to D1 or Postgres later does not change the routing or quota ports.

## Rejected alternatives

- Independent local and Cloudflare routers: quota and learning state diverge.
- Multi-master SQLite synchronization: too complex and cannot provide reliable global admission.
- An LLM selecting the provider: adds latency, cost, nondeterminism, and another failure dependency.
- A learned score containing safety penalties: a sufficiently large reward could override them. Hard constraints therefore remain gates.
