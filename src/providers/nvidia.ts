import type { GenerationRequest, ModelProfile } from "../core/types";

const NVIDIA_CHAT_COMPLETIONS = "https://integrate.api.nvidia.com/v1/chat/completions";

export async function invokeNvidia(
  request: GenerationRequest,
  model: ModelProfile,
  apiKey: string,
  signal?: AbortSignal,
  endpoint = NVIDIA_CHAT_COMPLETIONS,
): Promise<Response> {
  const {
    route: _route,
    model: _model,
    chat_template_kwargs: rawTemplateOptions,
    reasoning_effort: _rawReasoningEffort,
    ...body
  } = request;
  const callerTemplateOptions = asRecord(rawTemplateOptions);
  const isGptOss = model.upstreamModel.startsWith("openai/gpt-oss-");
  const reasoningControls = isGptOss
    ? { reasoning_effort: request.route?.reasoning === "on" ? "high" : "low" }
    : {
        chat_template_kwargs: {
          ...callerTemplateOptions,
          enable_thinking: request.route?.reasoning === "on",
        },
      };
  return fetch(endpoint, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      Accept: request.stream ? "text/event-stream" : "application/json",
    },
    body: JSON.stringify({
      ...body,
      model: model.upstreamModel,
      // GPT-OSS exposes reasoning_effort rather than an off switch. Keep the default at the
      // provider's minimum and rely on the semantic output gate if reasoning exhausts the budget.
      ...reasoningControls,
    }),
    signal,
  });
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}
