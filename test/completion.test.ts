import { describe, expect, it } from "vitest";
import { validateChatCompletion } from "../src/core/completion";

describe("completion validity gate", () => {
  it("rejects a reasoning-only completion that exhausted its output budget", () => {
    expect(validateChatCompletion({
      choices: [{ message: { content: null, reasoning_content: "hidden" }, finish_reason: "length" }],
    })).toEqual({ valid: false, failure: "empty_output" });
  });

  it("rejects visibly truncated output so another provider can finish the answer", () => {
    expect(validateChatCompletion({
      choices: [{ message: { content: "A partial answer" }, finish_reason: "length" }],
    })).toEqual({ valid: false, failure: "truncated_output" });
  });

  it("accepts visible content, refusals, and tool calls", () => {
    expect(validateChatCompletion({
      choices: [{ message: { content: "OK" }, finish_reason: "stop" }],
    }).valid).toBe(true);
    expect(validateChatCompletion({
      choices: [{ message: { content: null, refusal: "Cannot comply" }, finish_reason: "stop" }],
    }).valid).toBe(true);
    expect(validateChatCompletion({
      choices: [{ message: { content: null, tool_calls: [{ id: "call_1" }] }, finish_reason: "tool_calls" }],
    }).valid).toBe(true);
  });
});
