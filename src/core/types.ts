export type MessageRole = "system" | "user" | "assistant" | "tool";

export interface ChatMessage {
  role: MessageRole;
  content: unknown;
  name?: string;
  tool_call_id?: string;
  [key: string]: unknown;
}

export interface ToolDefinition {
  type: "function";
  function: { name: string; description?: string; parameters?: Record<string, unknown> };
}

/** Deliberately close to OpenAI Chat Completions, with optional routing hints. */
export interface GenerationRequest {
  model?: string;
  messages: ChatMessage[];
  stream?: boolean;
  max_tokens?: number;
  temperature?: number;
  top_p?: number;
  tools?: ToolDefinition[];
  response_format?: unknown;
  /** Internal hint. Public clients may omit it. */
  route?: {
    tier?: "fast" | "balanced" | "reasoning";
    allowPaid?: boolean;
    /** Off by default: reasoning traces are costly and not part of the public response contract. */
    reasoning?: "off" | "on";
  };
  [key: string]: unknown;
}

export interface ModelProfile {
  id: string;
  provider: string;
  upstreamModel: string;
  contextWindow: number;
  maxOutputTokens: number;
  supports: { streaming: boolean; tools: boolean; structuredOutput: boolean; vision: boolean };
  tier: "fast" | "balanced" | "reasoning";
  free: boolean;
}

export interface RouteSelection {
  model: ModelProfile;
  estimatedInputTokens: number;
  reservedTokens: number;
}

export interface RateWindowLimit {
  /** Maximum accepted requests or reserved tokens during one fixed window. */
  limit: number;
  windowMs: number;
}

export interface ProviderRateLimitSettings {
  dailySafetyBudgetTokens: number;
  cooldownMs: number;
  requests?: RateWindowLimit;
  tokens?: RateWindowLimit;
  maxConcurrent?: number;
  /** A crashed invocation is conservatively released after this duration. */
  reservationTtlMs: number;
}

export type RouterErrorCode =
  | "invalid_request"
  | "authentication_error"
  | "server_configuration_error"
  | "context_unavailable"
  | "provider_unavailable"
  | "upstream_error";

export class RouterError extends Error {
  constructor(
    readonly code: RouterErrorCode,
    message: string,
    readonly status: number,
    readonly retryAfterMs?: number,
  ) {
    super(message);
  }
}
