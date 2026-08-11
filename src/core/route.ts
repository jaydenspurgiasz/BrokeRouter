import { NVIDIA_MODELS } from "./models";
import { RouterError, type GenerationRequest, type ModelProfile, type RouteSelection } from "./types";

const CONTEXT_SAFETY_MARGIN = 1_024;

export function estimateInputTokens(request: GenerationRequest): number {
  // Conservative, tokenizer-neutral estimate. Providers may later supply tokenizers as adapters.
  return Math.ceil(JSON.stringify(request.messages).length / 3.5);
}

function needsVision(request: GenerationRequest): boolean {
  return request.messages.some((message) => JSON.stringify(message.content).includes("image_url"));
}

export function selectRoute(request: GenerationRequest, catalog: ModelProfile[] = NVIDIA_MODELS): RouteSelection {
  return selectRoutes(request, catalog)[0];
}

/**
 * Returns every capable candidate in deterministic preference order. Runtime admission control
 * decides which provider can receive the call now.
 */
export function selectRoutes(request: GenerationRequest, catalog: ModelProfile[] = NVIDIA_MODELS): RouteSelection[] {
  if (!Array.isArray(request.messages) || request.messages.length === 0) {
    throw new RouterError("invalid_request", "messages must be a non-empty array", 400);
  }

  const requestedOutput = Math.max(1, request.max_tokens ?? 1_024);
  const inputTokens = estimateInputTokens(request);
  const requestedModel = request.model ?? "free/default";
  const desiredTier = request.route?.tier;

  const candidates = catalog.filter((candidate) => {
    if (!candidate.free && !request.route?.allowPaid) return false;
    if (requestedModel === "free/default" && candidate.automaticRouting === false) return false;
    if (requestedModel !== "free/default" && requestedModel !== candidate.id) return false;
    if (desiredTier && candidate.tier !== desiredTier) return false;
    if (request.stream && !candidate.supports.streaming) return false;
    if (request.tools?.length && !candidate.supports.tools) return false;
    if (needsVision(request) && !candidate.supports.vision) return false;
    return inputTokens + requestedOutput + CONTEXT_SAFETY_MARGIN <= candidate.contextWindow
      && requestedOutput <= candidate.maxOutputTokens;
  });

  if (candidates.length === 0) {
    throw new RouterError(
      "context_unavailable",
      "No allowed model can preserve this request's required context and capabilities.",
      422,
    );
  }

  return candidates.map((model) => ({
    model,
    estimatedInputTokens: inputTokens,
    reservedTokens: inputTokens + requestedOutput,
  }));
}
