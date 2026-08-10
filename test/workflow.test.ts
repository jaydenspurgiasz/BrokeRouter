import { describe, expect, it } from "vitest";
import { applyWorkflowContext, parseWorkflowOutcome, parseWorkflowSpec, workflowContextKey, type WorkflowRecord } from "../src/core/workflow";
import type { GenerationRequest } from "../src/core/types";

describe("workflow contracts", () => {
  it("validates bounded workflow capacity", () => {
    expect(parseWorkflowSpec({ workflowType: "coding-agent", expectedCalls: 5, maxCalls: 8, maxConcurrency: 3 })).toMatchObject({
      workflowType: "coding-agent", expectedCalls: 5, maxCalls: 8, maxConcurrency: 3,
    });
    expect(() => parseWorkflowSpec({ expectedCalls: 5, maxCalls: 2 })).toThrow();
  });

  it("overwrites untrusted call hints with durable workflow state", () => {
    const request: GenerationRequest = {
      messages: [{ role: "user", content: "hello" }],
      route: { expectedCalls: 999, preferredProviderId: "spoofed" },
    };
    const effective = applyWorkflowContext(request, workflow());
    expect(effective.route?.expectedCalls).toBe(4);
    expect(effective.route?.preferredProviderId).toBe("nvidia");
    expect(workflowContextKey(effective)).toBe("coding-agent:reasoning");
  });

  it("accepts bounded terminal quality feedback", () => {
    expect(parseWorkflowOutcome({ success: true, quality: 0.9, validatorPassed: true })).toEqual({
      success: true, quality: 0.9, validatorPassed: true, deadlineMet: undefined,
    });
    expect(() => parseWorkflowOutcome({ success: true, quality: 2 })).toThrow();
  });
});

function workflow(): WorkflowRecord {
  return {
    id: "wf", ownerId: "caller", environment: "production", status: "active",
    workflowType: "coding-agent", expectedCalls: 5, maxCalls: 8, maxConcurrency: 3,
    estimatedTotalTokens: 10_000, qualityTier: "reasoning", priority: 50,
    createdAt: 1, updatedAt: 1, callsStarted: 1, callsCompleted: 1, inFlight: 0,
    actualTokens: 1_000, primaryProvider: "nvidia", primaryModel: "nvidia/model",
  };
}
