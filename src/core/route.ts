import { NVIDIA_MODELS } from "./models";
import { RouterError, type GenerationRequest, type ModelProfile, type RouteSelection } from "./types";
import { satisfiesVirtualModel, virtualModel } from "./virtual-models";

const CONTEXT_SAFETY_MARGIN = 1_024;

export function estimateInputTokens(request: GenerationRequest): number {
  // Conservative, tokenizer-neutral estimate. Providers may later supply tokenizers as adapters.
  return Math.ceil(JSON.stringify(request.messages).length / 3.5);
}

function needsVision(request: GenerationRequest): boolean {
  return request.messages.some((message) => {
    if (!message || typeof message !== "object") return false;
    const content = JSON.stringify(message.content);
    return typeof content === "string" && content.includes("image_url");
  });
}

function isChatMessage(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const message = value as Record<string, unknown>;
  if (message.role !== "system" && message.role !== "user"
    && message.role !== "assistant" && message.role !== "tool") return false;
  return "content" in message || (message.role === "assistant" && Array.isArray(message.tool_calls));
}

export function selectRoute(request: GenerationRequest, catalog: ModelProfile[] = NVIDIA_MODELS): RouteSelection {
  return selectRoutes(request, catalog)[0];
}

/**
 * Returns every capable candidate in deterministic preference order. Runtime admission control
 * decides which provider can receive the call now.
 */
export function selectRoutes(request: GenerationRequest, catalog: ModelProfile[] = NVIDIA_MODELS): RouteSelection[] {
  if (!Array.isArray(request.messages) || request.messages.length === 0
    || !request.messages.every(isChatMessage)) {
    throw new RouterError("invalid_request", "messages must be a non-empty array of chat messages", 400);
  }
  if (request.route?.affinityKey !== undefined
    && (typeof request.route.affinityKey !== "string"
      || request.route.affinityKey.trim().length === 0
      || request.route.affinityKey.length > 256)) {
    throw new RouterError("invalid_request", "route.affinityKey must be a non-empty string of at most 256 characters", 400);
  }

  const requestedOutput = Math.max(1, request.max_tokens ?? 1_024);
  const inputTokens = estimateInputTokens(request);
  const requestedModel = request.model ?? "free/default";
  const virtual = virtualModel(requestedModel);
  const desiredTier = request.route?.tier;

  const candidates = catalog.filter((candidate) => {
    if (virtual) {
      if (request.stream && !virtual.supports.streaming) return false;
      if (request.tools?.length && !virtual.supports.tools) return false;
      if (needsVision(request) && !virtual.supports.vision) return false;
      if (!satisfiesVirtualModel(candidate, virtual)) return false;
    } else {
      if (!candidate.free && !request.route?.allowPaid) return false;
      if (requestedModel === "free/default" && candidate.automaticRouting === false) return false;
      if (requestedModel !== "free/default" && requestedModel !== candidate.id) return false;
    }
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
