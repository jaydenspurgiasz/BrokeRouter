export type CompletionFailure = "missing_choice" | "empty_output" | "truncated_output";

export interface CompletionValidation {
  valid: boolean;
  failure?: CompletionFailure;
}

/** Validates the public Chat Completions contract after provider-private reasoning is removed. */
export function validateChatCompletion(payload: Record<string, unknown>): CompletionValidation {
  const choices = payload.choices;
  if (!Array.isArray(choices) || choices.length === 0) return { valid: false, failure: "missing_choice" };

  const choice = record(choices[0]);
  const message = record(choice?.message);
  if (!message || !hasVisibleOutput(message)) return { valid: false, failure: "empty_output" };
  if (choice?.finish_reason === "length") return { valid: false, failure: "truncated_output" };
  return { valid: true };
}

function hasVisibleOutput(message: Record<string, unknown>): boolean {
  return hasContent(message.content)
    || hasContent(message.refusal)
    || nonEmptyArray(message.tool_calls)
    || Boolean(record(message.function_call));
}

function hasContent(value: unknown): boolean {
  if (typeof value === "string") return value.trim().length > 0;
  if (!Array.isArray(value)) return false;
  return value.some((part) => {
    if (typeof part === "string") return part.trim().length > 0;
    const item = record(part);
    return item ? hasContent(item.text) || hasContent(item.content) : false;
  });
}

function nonEmptyArray(value: unknown): boolean {
  return Array.isArray(value) && value.length > 0;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}
