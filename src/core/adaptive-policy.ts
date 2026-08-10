import { rankCandidates, type AvailableCandidate, type RankedCandidate } from "./policy";
import type { GenerationRequest } from "./types";

export type PolicyMode = "baseline" | "shadow" | "adaptive";

export interface ProviderStatistics {
  providerId: string;
  modelId: string;
  observations: number;
  successAlpha: number;
  successBeta: number;
  completionAlpha: number;
  completionBeta: number;
  rateLimitAlpha: number;
  rateLimitBeta: number;
  qualityMean: number;
  qualityCount: number;
  latencyEwmaMs?: number;
  tokensEwma?: number;
}

export interface PolicyDecision {
  ranked: RankedPolicyCandidate[];
  baselineWinner?: string;
  shadowWinner?: string;
  activePolicy: string;
  policyVersion: string;
  propensity: number;
  explored: boolean;
}

export interface RankedPolicyCandidate extends RankedCandidate {
  learnedScore: number;
  posteriorSuccess: number;
  posteriorRateLimitRisk: number;
}

export function decidePolicy(
  request: GenerationRequest,
  candidates: AvailableCandidate[],
  statistics: ProviderStatistics[],
  options: { mode: PolicyMode; explorationRate: number; minObservations: number; random?: () => number },
): PolicyDecision {
  const baseline = rankCandidates(request, candidates);
  const adaptive = rankWithStatistics(baseline, statistics);
  const baselineWinner = key(baseline[0]);
  const adaptiveWinner = key(adaptive[0]);
  const enoughEvidence = statistics.some((statistic) => statistic.observations >= options.minObservations);

  if (options.mode === "baseline" || !enoughEvidence) {
    return {
      ranked: baseline.map((candidate) => learnedCandidate(candidate)),
      baselineWinner,
      shadowWinner: options.mode === "shadow" ? adaptiveWinner : undefined,
      activePolicy: enoughEvidence ? "deterministic-best-fit-v1" : "deterministic-best-fit-v1:cold-start",
      policyVersion: "deterministic-best-fit-v1",
      propensity: 1,
      explored: false,
    };
  }

  if (options.mode === "shadow") {
    return {
      ranked: baseline.map((candidate) => learnedCandidate(candidate)),
      baselineWinner,
      shadowWinner: adaptiveWinner,
      activePolicy: "deterministic-best-fit-v1",
      policyVersion: "bayesian-epsilon-greedy-v1:shadow",
      propensity: 1,
      explored: false,
    };
  }

  const random = options.random ?? Math.random;
  const epsilon = clamp(options.explorationRate, 0, 0.25);
  const explore = adaptive.length > 1 && random() < epsilon;
  let ranked = adaptive;
  let selectedIndex = 0;
  if (explore) {
    selectedIndex = Math.min(adaptive.length - 1, Math.floor(random() * adaptive.length));
    ranked = [adaptive[selectedIndex], ...adaptive.filter((_, index) => index !== selectedIndex)];
  }
  const selectedIsExploit = selectedIndex === 0;
  return {
    ranked,
    baselineWinner,
    shadowWinner: undefined,
    activePolicy: "bayesian-epsilon-greedy-v1",
    policyVersion: "bayesian-epsilon-greedy-v1",
    propensity: selectedIsExploit ? 1 - epsilon + epsilon / adaptive.length : epsilon / adaptive.length,
    explored: explore,
  };
}

export function rankWithStatistics(
  baseline: RankedCandidate[], statistics: ProviderStatistics[],
): RankedPolicyCandidate[] {
  return baseline.map((candidate) => {
    const statistic = statistics.find((item) => item.providerId === candidate.providerId && item.modelId === candidate.selection.model.id);
    const success = statistic ? statistic.successAlpha / (statistic.successAlpha + statistic.successBeta) : 0.5;
    const completion = statistic ? statistic.completionAlpha / (statistic.completionAlpha + statistic.completionBeta) : 0.5;
    const rateRisk = statistic ? statistic.rateLimitAlpha / (statistic.rateLimitAlpha + statistic.rateLimitBeta) : 0.1;
    const quality = statistic?.qualityCount ? statistic.qualityMean : 0.5;
    const latencyPenalty = statistic?.latencyEwmaMs ? Math.log1p(statistic.latencyEwmaMs) * 8 : 0;
    const uncertaintyBonus = statistic ? 80 / Math.sqrt(statistic.observations + 1) : 80;
    return {
      ...candidate,
      learnedScore: candidate.score + (success - 0.5) * 350 + (completion - 0.5) * 650 + (quality - 0.5) * 250
        - rateRisk * 350 - latencyPenalty + uncertaintyBonus,
      posteriorSuccess: success,
      posteriorRateLimitRisk: rateRisk,
    };
  }).sort((left, right) => right.learnedScore - left.learnedScore || right.score - left.score);
}

function learnedCandidate(candidate: RankedCandidate): RankedPolicyCandidate {
  return { ...candidate, learnedScore: candidate.score, posteriorSuccess: 0.5, posteriorRateLimitRisk: 0.1 };
}

function key(candidate: RankedCandidate | undefined): string | undefined {
  return candidate ? `${candidate.providerId}:${candidate.selection.model.id}` : undefined;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, Number.isFinite(value) ? value : minimum));
}
