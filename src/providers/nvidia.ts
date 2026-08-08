import type { GenerationRequest, ModelProfile } from "../core/types";

const NVIDIA_CHAT_COMPLETIONS = "https://integrate.api.nvidia.com/v1/chat/completions";

export async function invokeNvidia(
  request: GenerationRequest,
  model: ModelProfile,
  apiKey: string,
): Promise<Response> {
  const { route: _route, model: _model, ...body } = request;
  const callerTemplateOptions = asRecord(body.chat_template_kwargs);
  return fetch(NVIDIA_CHAT_COMPLETIONS, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      Accept: request.stream ? "text/event-stream" : "application/json",
    },
    body: JSON.stringify({
      ...body,
      model: model.upstreamModel,
      // NVIDIA reasoning can consume the whole output allowance. It is opt-in through the router,
      // rather than an accidental consequence of a provider default.
      chat_template_kwargs: {
        ...callerTemplateOptions,
        enable_thinking: request.route?.reasoning === "on",
      },
    }),
  });
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}
