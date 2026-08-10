# ADR 0004: Hierarchical Bayesian online policy with safe activation

- Status: accepted
- Date: 2026-08-09

## Context

Personal traffic is sparse, providers change behavior, and workflow types have different completion, quality, latency, and quota requirements. A large neural model is not statistically justified and would make routing slower and less explainable. Pure greedy learning cannot be evaluated reliably because it never observes counterfactual routes.

## Decision

BrokeRouter maintains Beta posteriors for provider call success, workflow completion, and rate-limit risk; empirical bounded quality estimates; and exponentially weighted latency/token estimates. Statistics are stored at global, workflow-context, and caller-context scopes. Sparse caller estimates shrink toward workflow and global evidence. Workflow call counts use online mean/variance estimates with Poisson or negative-binomial classification, while token forecasts use online upper quantiles.

The adaptive policy adds learned utility and uncertainty bonuses to the deterministic best-fit score. Exploration is epsilon-greedy, capped at 25%, restricted to providers that passed every hard gate, and logs the exact action propensity. This supports inverse propensity scoring and self-normalized off-policy evaluation.

Policy modes are:

- `baseline`: deterministic best-fit only.
- `shadow`: baseline controls traffic while adaptive recommendations are logged.
- `adaptive`: the Bayesian policy controls traffic after the evidence threshold is met.

Policy control and learning state are sharded per environment in strongly consistent Durable Objects; individual workflows are sharded by workflow ID. An authorized caller can switch modes immediately without deploying. Configuration variables supply safe defaults only.

Workflow success and quality are explicit terminal feedback. Call HTTP success is useful evidence but is not treated as equivalent to workflow completion.

## Safety invariants

- Authentication, authorization, free/paid policy, capabilities, context fit, quota, cooldown, and concurrency are gates outside learned scoring.
- Cold start always falls back to deterministic routing.
- Production, staging, development, and evaluation statistics never mix.
- Raw prompts, completions, tool arguments, secrets, and reasoning traces cannot enter the event schema.
- Every decision stores policy version, candidate features, chosen action, propensity, and any shadow recommendation.

## Consequences

- The policy learns continuously from low-volume traffic without a training pipeline.
- Logged propensities make candidate policies quantitatively evaluable before activation.
- Hierarchical shrinkage reduces overfitting to one caller or workflow.
- Runtime rollback is immediate.
- The statistical model is intentionally simple enough to audit, simulate, and explain in an interview.
