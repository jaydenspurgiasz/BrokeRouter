import type { GenerationRequest, RouteSelection } from "./types";

export interface AvailabilitySnapshot {
  requestCapacity?: number;
  tokenCapacity?: number;
  concurrentAvailable?: number;
  dailyTokensRemaining?: number;
}

export interface AvailableCandidate {
  selection: RouteSelection;
  providerId: string;
  credentialScope: string;
  availability: AvailabilitySnapshot;
  catalogOrder: number;
}

export interface RankedCandidate extends AvailableCandidate {
  policy: "deterministic-best-fit-v1";
  score: number;
}

/**
 * Explainable baseline policy. It favors candidates that fit the whole expected workflow while
 * preserving scarce headroom. A learned policy can replace this port without touching gates.
 */
export function rankCandidates(request: GenerationRequest, candidates: AvailableCandidate[]): RankedCandidate[] {
  const expectedCalls = boundedPositive(request.route?.expectedCalls, 1, 1_000);
  const expectedTokens = boundedPositive(
    request.route?.estimatedTotalTokens,
    candidates[0]?.selection.reservedTokens * expectedCalls || 1,
    Number.MAX_SAFE_INTEGER,
  );
  const expectedConcurrency = boundedPositive(request.route?.maxConcurrency, 1, 1_000);

  return candidates.map((candidate) => {
    const availability = candidate.availability;
    const workflowFits = fits(availability.requestCapacity, expectedCalls)
      && fits(availability.tokenCapacity, expectedTokens)
      && fits(availability.concurrentAvailable, expectedConcurrency)
      && fits(availability.dailyTokensRemaining, expectedTokens);
    const capacityScore = bestFitScore(availability.requestCapacity, expectedCalls)
      + bestFitScore(availability.tokenCapacity, expectedTokens)
      + bestFitScore(availability.dailyTokensRemaining, expectedTokens)
      + bestFitScore(availability.concurrentAvailable, expectedConcurrency);
    const tierScore = request.route?.qualityTier === "reasoning"
      ? (candidate.selection.model.tier === "reasoning" ? 100 : 0)
      : request.route?.tier
        ? (candidate.selection.model.tier === request.route.tier ? 50 : 0)
        : 0;
    const switchingPenalty = request.route?.preferredProviderId
      && request.route.preferredProviderId !== candidate.providerId ? 120 : 0;
    return {
      ...candidate,
      policy: "deterministic-best-fit-v1" as const,
      // Catalog order is the stable final tie-breaker. Workflow fit dominates soft preferences.
      score: (workflowFits ? 10_000 : 0) + capacityScore + tierScore - switchingPenalty - candidate.catalogOrder / 1_000,
    };
  }).sort((left, right) => right.score - left.score || left.catalogOrder - right.catalogOrder);
}

function fits(available: number | undefined, required: number): boolean {
  return available === undefined || available >= required;
}

function bestFitScore(available: number | undefined, required: number): number {
  if (available === undefined) return 10;
  const ratio = available / Math.max(1, required);
  // Among providers that fit, reward the tightest safe bin to preserve large quotas for large
  // workflows. If none fit the whole workflow, reward partial coverage for graceful degradation.
  return ratio >= 1 ? 50 / ratio : ratio * 25;
}

function boundedPositive(value: number | undefined, fallback: number, maximum: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.min(maximum, value)
    : fallback;
}
