# ADR 0002: Credential-scoped provider admission control

**Status:** Accepted

## Context

Free provider limits are multidimensional. A request may be blocked by a request-rate window, a token-rate window, concurrent generations, a daily local safety ceiling, or an upstream quota signal. Agent calls are concurrent, so local in-memory counters cannot reliably protect a shared provider key across Worker invocations.

## Decision

The provider credential is the atom of coordination. Each provider credential receives one SQLite-backed Durable Object. Before any upstream call, the gateway atomically reserves the request's estimated input plus its maximum requested output. The coordinator enforces configured fixed request windows, configured fixed token windows, concurrent reservation count, daily safety budget, and cooldown/reset time. Reservation expiry recovers from a failed invocation conservatively.

The routing sequence is capability filter, immediate provider admission, then bounded inline waiting. A capable provider with an unavailable admission slot is not a route failure: the policy proceeds to another provider candidate. Only when no candidate can admit does the gateway wait up to `MAX_INLINE_WAIT_MS`; after that it sends a structured `503` with the earliest retry time. Long-lived queuing belongs to a future asynchronous job adapter because it should not hold an agent's interactive HTTP turn open.

## Consequences

Configured limits are predictions and must be conservative. Provider `429`/reset signals override them. A provider can have global, credential, model, and organization limits, so model catalog records and future provider adapters must declare the proper credential scope before being added. The first NVIDIA adapter shares one scope across its model aliases; new credentials or providers create independent scopes.
