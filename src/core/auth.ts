import type { Env } from "../config";
import { RouterError } from "./types";

export type CallerScope = "models:read" | "chat:write" | "jobs:write" | "jobs:read" | "providers:paid";

export interface AuthenticatedCaller {
  id: string;
  environment: "production" | "staging" | "development" | "evaluation";
  scopes: ReadonlySet<CallerScope>;
}

interface CredentialRecord {
  keyHash: string;
  environment?: AuthenticatedCaller["environment"];
  scopes?: CallerScope[];
  enabled?: boolean;
}

const ALL_SCOPES: CallerScope[] = ["models:read", "chat:write", "jobs:write", "jobs:read"];
const ENVIRONMENTS = new Set<AuthenticatedCaller["environment"]>(["production", "staging", "development", "evaluation"]);
const SCOPES = new Set<CallerScope>([...ALL_SCOPES, "providers:paid"]);

/**
 * Authenticates a high-entropy, independently revocable caller credential.
 * Token format: `brk_<key-id>.<secret>`. Only SHA-256 hashes live in the registry secret.
 */
export async function authenticateCaller(request: Request, env: Pick<Env, "CALLER_CREDENTIALS_JSON" | "ROUTER_API_KEY">): Promise<AuthenticatedCaller> {
  const authorization = request.headers.get("authorization") ?? "";
  const token = authorization.startsWith("Bearer ") ? authorization.slice(7) : "";

  if (env.CALLER_CREDENTIALS_JSON) {
    const registry = parseRegistry(env.CALLER_CREDENTIALS_JSON);
    const separator = token.indexOf(".");
    if (!token.startsWith("brk_") || separator < 5) throw unauthorized();
    const id = token.slice(4, separator);
    const secret = token.slice(separator + 1);
    const record = registry[id];
    if (!record || record.enabled === false || secret.length < 32) throw unauthorized();
    const digest = await sha256Hex(secret);
    if (!constantTimeTextEqual(digest, record.keyHash.toLowerCase())) throw unauthorized();
    return {
      id,
      environment: record.environment ?? "production",
      scopes: new Set(record.scopes ?? ALL_SCOPES),
    };
  }

  // Keeps existing local installations usable while they migrate. Production documentation
  // requires CALLER_CREDENTIALS_JSON so each agent can be revoked independently.
  if (env.ROUTER_API_KEY && await digestEqual(token, env.ROUTER_API_KEY)) {
    return { id: "legacy-local", environment: "development", scopes: new Set(ALL_SCOPES) };
  }
  if (!env.ROUTER_API_KEY) {
    throw new RouterError("server_configuration_error", "No caller credential registry is configured.", 503);
  }
  throw unauthorized();
}

export function requireScope(caller: AuthenticatedCaller, scope: CallerScope): void {
  if (!caller.scopes.has(scope)) {
    throw new RouterError("authorization_error", `Caller is missing the ${scope} scope.`, 403);
  }
}

function parseRegistry(raw: string): Record<string, CredentialRecord> {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error();
    const registry = parsed as Record<string, CredentialRecord>;
    for (const [id, record] of Object.entries(registry)) {
      if (!/^[a-z0-9][a-z0-9-]{1,62}$/.test(id)
        || !record || typeof record !== "object"
        || typeof record.keyHash !== "string" || !/^[a-f0-9]{64}$/i.test(record.keyHash)
        || (record.environment !== undefined && !ENVIRONMENTS.has(record.environment))
        || (record.scopes !== undefined && (!Array.isArray(record.scopes) || record.scopes.some((scope) => !SCOPES.has(scope))))) {
        throw new Error();
      }
    }
    return registry;
  } catch {
    throw new RouterError("server_configuration_error", "CALLER_CREDENTIALS_JSON is invalid.", 503);
  }
}

async function digestEqual(left: string, right: string): Promise<boolean> {
  const [leftDigest, rightDigest] = await Promise.all([sha256Hex(left), sha256Hex(right)]);
  return constantTimeTextEqual(leftDigest, rightDigest);
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function constantTimeTextEqual(left: string, right: string): boolean {
  const length = Math.max(left.length, right.length);
  let difference = left.length ^ right.length;
  for (let index = 0; index < length; index += 1) {
    difference |= (left.charCodeAt(index) || 0) ^ (right.charCodeAt(index) || 0);
  }
  return difference === 0;
}

function unauthorized(): RouterError {
  return new RouterError("authentication_error", "Invalid caller credential.", 401);
}
