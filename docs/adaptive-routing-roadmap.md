# Adaptive routing implementation status

## Milestone 1: secure gated planner

- [x] Per-caller hashed identity and endpoint scopes.
- [x] Capability, context, paid-provider, quota, cooldown, and concurrency gates.
- [x] Concurrent non-mutating availability inspection.
- [x] Atomic reservation with ordered race fallback.
- [x] Versioned deterministic best-fit policy.
- [x] Shared multi-provider execution for interactive and durable jobs.
- [x] Caller-owned asynchronous results.
- [x] Caller-scoped request, token, daily, and concurrency admission gates.

## Milestone 2: workflow and observation plane

- [x] Durable workflow creation, ownership, deadlines, call limits, and concurrency leases.
- [x] Server-owned workflow context overriding untrusted per-call hints.
- [x] Provider affinity, call accounting, terminal success, validation, deadline, and quality feedback.
- [x] Metadata-only decision, call-outcome, workflow-outcome, and policy-statistic tables.
- [x] Environment-separated production, staging, development, and evaluation learning.
- [x] Latency, time-to-first-token, actual token, HTTP, and rate-limit observations.
- [x] Raw prompt/completion exclusion at the storage type and SQL boundary.

## Milestone 3: evaluation and online learning

- [x] Hierarchical Bayesian success and rate-limit estimates.
- [x] Online quality, latency, and token estimates.
- [x] Workflow-completion posteriors and online call/token forecasts for underspecified workflows.
- [x] Global, workflow-context, and caller-context partial pooling.
- [x] Baseline, shadow, and adaptive modes.
- [x] Bounded safe exploration with logged action propensities.
- [x] Cold-start evidence threshold.
- [x] Immediate authenticated policy activation and rollback.
- [x] Deterministic workload simulation.
- [x] IPS, SNIPS, and effective-sample-size off-policy evaluation primitives.
- [x] Unit and isolated real-provider integration coverage.

## Operations remaining for an account owner

- [ ] Set the personal deployment's provider/caller secrets in Cloudflare.
- [x] Use the account's `workers.dev` hostname for the personal MVP; custom domain is optional later.
- [ ] Create Cloudflare Access applications and service-auth policies.
- [ ] Add the custom-domain routes after the hostnames are known.
- [ ] Add GitHub Actions secrets and run the first manual deployment.

These are account-specific deployment actions, not unfinished application code.
