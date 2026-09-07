import type { ModelProfile } from "./types";

export interface VirtualModelProfile extends ModelProfile {
  object: "model";
  owned_by: "brokerouter";
  virtual: true;
}

/** Stable client-facing contracts. These records are never invoked as upstream models. */
export const VIRTUAL_MODELS: VirtualModelProfile[] = [{
  id: "free/hermes",
  object: "model",
  owned_by: "brokerouter",
  virtual: true,
  provider: "brokerouter",
  upstreamModel: "free/hermes",
  contextWindow: 65_536,
  maxOutputTokens: 4_096,
  supports: { streaming: true, tools: true, structuredOutput: false, vision: false },
  tier: "balanced",
  free: true,
  automaticRouting: false,
}];

export function virtualModel(id: string): VirtualModelProfile | undefined {
  return VIRTUAL_MODELS.find((model) => model.id === id);
}

export function satisfiesVirtualModel(candidate: ModelProfile, virtual: VirtualModelProfile): boolean {
  if (candidate.automaticRouting === false) return false;
  if (virtual.free && !candidate.free) return false;
  return candidate.contextWindow >= virtual.contextWindow
    && candidate.maxOutputTokens >= virtual.maxOutputTokens
    && (!virtual.supports.streaming || candidate.supports.streaming)
    && (!virtual.supports.tools || candidate.supports.tools)
    && (!virtual.supports.structuredOutput || candidate.supports.structuredOutput)
    && (!virtual.supports.vision || candidate.supports.vision);
}
