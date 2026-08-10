# Adaptive routing implementation roadmap

This is the implementation record for turning BrokeRouter into a constrained, self-improving workflow router.

## Milestone 1: secure gated planner

- [x] Explicit authenticated caller identity and endpoint scopes.
- [x] Backward-compatible local migration from the legacy single key.
- [x] Capability and context filters remain hard gates.
- [x] Non-mutating provider availability inspection before ranking.
- [x] Concurrent inspection across provider Durable Objects.
- [x] Versioned deterministic best-fit policy.
- [x] Atomic winner reservation with ordered race fallback.
- [x] Shared multi-provider execution for interactive and durable jobs.
- [x] Caller-owned asynchronous job results.
- [ ] Configure the real custom hostname and Cloudflare Access policy during deployment.

## Milestone 2: workflow and observation plane

- Add a `RoutingState` Durable Object with metadata-only SQLite tables for decisions, call outcomes, workflow outcomes, policy statistics, and policy versions.
- Add workflow lifecycle endpoints and durable workflow reservations.
- Derive `clientId` and environment only from authentication; accept workflow properties as untrusted optimization hints.
- Separate production, staging, development, evaluation, shadow, and synthetic observations.
- Add provider latency, time-to-first-token, actual token usage, validation, and rate-limit observations.
- Refuse raw prompts or completions at the storage boundary.

## Milestone 3: evaluation and online learning

- Build deterministic workload simulation and historical replay.
- Estimate success and completion with Bayesian posteriors, latency with online distributions, and calls/tokens with online count and quantile models.
- Use global priors with caller/workflow-specific partial pooling.
- Run contextual policy recommendations in shadow mode.
- Compare completion, quality, latency, quota exhaustion, and deadline metrics against the deterministic baseline.
- Activate bounded exploration only after evaluation thresholds pass.
- Keep policy version rollback instantaneous and keep all hard gates outside learned scoring.

## Target objective

The learned policy maximizes expected workflow value subject to hard security, capability, spend, and admission constraints:

```text
workflow value
× sampled completion probability
× sampled quality
− latency penalty
− quota opportunity cost
− provider switching penalty
− uncertainty risk
```

The metric of record is end-to-end workflow completion under free-tier constraints, not individual-call success alone.
