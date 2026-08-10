import { rankCandidates, type AvailableCandidate } from "./policy";
import type { GenerationRequest } from "./types";

export interface LoggedBanditOutcome {
  reward: number;
  loggedPropensity: number;
  targetPropensity: number;
}

export interface OffPolicyEstimate {
  inversePropensityScore: number;
  selfNormalizedScore: number;
  effectiveSampleSize: number;
  samples: number;
}

/** Standard IPS/SNIPS evaluation for safely comparing a candidate policy from logged traffic. */
export function evaluateOffPolicy(events: LoggedBanditOutcome[]): OffPolicyEstimate {
  const valid = events.filter((event) => Number.isFinite(event.reward)
    && event.loggedPropensity > 0 && event.loggedPropensity <= 1
    && event.targetPropensity >= 0 && event.targetPropensity <= 1);
  if (!valid.length) return { inversePropensityScore: 0, selfNormalizedScore: 0, effectiveSampleSize: 0, samples: 0 };
  let weightedReward = 0;
  let weightSum = 0;
  let squaredWeightSum = 0;
  for (const event of valid) {
    const weight = event.targetPropensity / event.loggedPropensity;
    weightedReward += weight * event.reward;
    weightSum += weight;
    squaredWeightSum += weight * weight;
  }
  return {
    inversePropensityScore: weightedReward / valid.length,
    selfNormalizedScore: weightSum > 0 ? weightedReward / weightSum : 0,
    effectiveSampleSize: squaredWeightSum > 0 ? (weightSum * weightSum) / squaredWeightSum : 0,
    samples: valid.length,
  };
}

export interface SimulatedWorkflow {
  id: string;
  expectedCalls: number;
  maxConcurrency: number;
  estimatedTokens: number;
  priority?: number;
}

export interface SimulatedProvider extends AvailableCandidate {
  successProbability: number;
}

export interface SimulationResult {
  completed: number;
  rejected: number;
  expectedValue: number;
  allocations: Record<string, number>;
}

/** Deterministic expected-value simulator using the production best-fit policy. */
export function simulateWorkloads(
  workflows: SimulatedWorkflow[], providers: SimulatedProvider[],
): SimulationResult {
  const mutable = providers.map((provider) => ({ ...provider, availability: { ...provider.availability } }));
  const allocations: Record<string, number> = {};
  let completed = 0;
  let rejected = 0;
  let expectedValue = 0;
  for (const workflow of [...workflows].sort((left, right) => (right.priority ?? 50) - (left.priority ?? 50))) {
    const request: GenerationRequest = {
      messages: [{ role: "user", content: "synthetic-workload" }],
      route: {
        expectedCalls: workflow.expectedCalls,
        maxConcurrency: workflow.maxConcurrency,
        estimatedTotalTokens: workflow.estimatedTokens,
      },
    };
    const eligible = mutable.filter((provider) => fitsWorkflow(workflow, provider));
    const selected = rankCandidates(request, eligible)[0];
    if (!selected) { rejected += 1; continue; }
    const provider = mutable.find((item) => item.providerId === selected.providerId
      && item.selection.model.id === selected.selection.model.id)!;
    consume(workflow, provider);
    allocations[provider.providerId] = (allocations[provider.providerId] ?? 0) + 1;
    completed += 1;
    expectedValue += (provider.successProbability ** workflow.expectedCalls) * ((workflow.priority ?? 50) / 50);
  }
  return { completed, rejected, expectedValue, allocations };
}

function fitsWorkflow(workflow: SimulatedWorkflow, provider: SimulatedProvider): boolean {
  return fits(provider.availability.requestCapacity, workflow.expectedCalls)
    && fits(provider.availability.tokenCapacity, workflow.estimatedTokens)
    && fits(provider.availability.dailyTokensRemaining, workflow.estimatedTokens)
    && fits(provider.availability.concurrentAvailable, workflow.maxConcurrency);
}
function fits(available: number | undefined, required: number): boolean { return available === undefined || available >= required; }
function consume(workflow: SimulatedWorkflow, provider: SimulatedProvider): void {
  if (provider.availability.requestCapacity !== undefined) provider.availability.requestCapacity -= workflow.expectedCalls;
  if (provider.availability.tokenCapacity !== undefined) provider.availability.tokenCapacity -= workflow.estimatedTokens;
  if (provider.availability.dailyTokensRemaining !== undefined) provider.availability.dailyTokensRemaining -= workflow.estimatedTokens;
}
