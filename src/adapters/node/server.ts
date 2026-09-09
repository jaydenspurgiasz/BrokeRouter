// @ts-ignore Node types are intentionally isolated from the Cloudflare Worker build.
import { createServer } from "node:http";
// @ts-ignore Node types are intentionally isolated from the Cloudflare Worker build.
import { readFileSync, existsSync, mkdirSync } from "node:fs";
// @ts-ignore Node types are intentionally isolated from the Cloudflare Worker build.
import { dirname, resolve } from "node:path";
import { authenticateCaller, requireScope } from "../../core/auth";
import { RouterError, type GenerationRequest, type ProviderRateLimitSettings } from "../../core/types";
import { satisfiesVirtualModel, virtualModel, VIRTUAL_MODELS } from "../../core/virtual-models";
import { registeredProviders } from "../cloudflare/provider-registry";
import { executeLocalGeneration } from "./execution";
import { SqliteState } from "./sqlite-state";

declare const process: any;
const env = loadEnvironment(process.env);
const host = env.BROKEROUTER_HOST ?? "127.0.0.1";
const port = positive(env.BROKEROUTER_PORT, 8787);
const databasePath = resolve(env.BROKEROUTER_DATABASE_PATH ?? "./data/brokerouter.sqlite");
mkdirSync(dirname(databasePath), { recursive: true });
const state = new SqliteState(databasePath);
const providers = registeredProviders(env as any);
const affinitySecret = env.BROKEROUTER_AFFINITY_SECRET ?? env.ROUTER_API_KEY;
if (!affinitySecret || affinitySecret.length < 32) throw new Error("BROKEROUTER_AFFINITY_SECRET or ROUTER_API_KEY must be at least 32 characters");
const validatedAffinitySecret = affinitySecret;

const server = createServer(async (incoming: any, outgoing: any) => {
  try {
    const request = await toRequest(incoming, host, port);
    const response = await handle(request);
    const responseHeaders: Record<string, string> = {};
    response.headers.forEach((value, name) => { responseHeaders[name] = value; });
    outgoing.writeHead(response.status, responseHeaders);
    if (!response.body) return outgoing.end();
    const reader = response.body.getReader();
    const cancelOnDisconnect = () => { void reader.cancel(); };
    outgoing.once("close", cancelOnDisconnect);
    while (true) { const chunk = await reader.read(); if (chunk.done) break; if (!outgoing.write(chunk.value)) await onceDrain(outgoing); }
    outgoing.off("close", cancelOnDisconnect);
    outgoing.end();
  } catch (error) {
    const routed = error instanceof RouterError ? error : undefined;
    if (outgoing.headersSent) { outgoing.destroy(); return; }
    if (!routed) console.error("Unhandled local router error", error);
    const status = routed?.status ?? 500;
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (routed?.retryAfterMs) headers["retry-after"] = String(Math.ceil(routed.retryAfterMs / 1_000));
    outgoing.writeHead(status, headers);
    outgoing.end(JSON.stringify({ error: { message: routed?.message ?? "Router failed while processing the request.", type: routed?.code ?? "upstream_error", code: routed?.code ?? "upstream_error" } }));
  }
});

async function handle(request: Request): Promise<Response> {
  const url = new URL(request.url);
  if (request.method === "GET" && url.pathname === "/health") return Response.json({ ok: true, service: "broke-router", runtime: "node-sqlite" });
  if (request.method === "GET" && url.pathname === "/ready") {
    const hermes = virtualModel("free/hermes")!;
    const ready = providers.some((provider) => provider.models.some((model) => satisfiesVirtualModel(model, hermes))) && state.ready();
    return Response.json({ ok: ready, providers: providers.length, runtime: "node-sqlite" }, { status: ready ? 200 : 503 });
  }
  const caller = await authenticateCaller(request, env as any);
  if (request.method === "GET" && url.pathname === "/v1/models") {
    requireScope(caller, "models:read");
    return Response.json({ object: "list", data: [...VIRTUAL_MODELS, ...providers.flatMap((provider) => provider.models)] });
  }
  if (request.method === "POST" && url.pathname === "/v1/chat/completions") {
    requireScope(caller, "chat:write");
    let generation: GenerationRequest;
    try { generation = await request.json() as GenerationRequest; }
    catch { throw new RouterError("invalid_request", "Request body must be valid JSON.", 400); }
    if (generation.route?.workflowId) {
      throw new RouterError("workflow_unavailable", "Durable workflow records are not enabled in the native runtime; use route.affinityKey for Hermes sessions.", 422);
    }
    if (generation.route?.allowPaid) requireScope(caller, "providers:paid");
    return executeLocalGeneration(generation, providers, state, {
      callerId: caller.id, environment: caller.environment, rateLimits: caller.rateLimits,
    }, validatedAffinitySecret, { upstreamTimeoutMs: positive(env.BROKEROUTER_UPSTREAM_TIMEOUT_MS, 30_000) });
  }
  throw new RouterError("invalid_request", "Not found", 404);
}

server.listen(port, host, () => console.log(`BrokeRouter listening on http://${host}:${port} with SQLite state at ${databasePath}`));
let stopping = false;
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => {
  if (stopping) return;
  stopping = true;
  const finish = () => { state.close(); process.exit(0); };
  server.close(finish);
  const force: any = setTimeout(() => { server.closeAllConnections?.(); finish(); }, 20_000);
  force.unref?.();
});

async function toRequest(incoming: any, fallbackHost: string, fallbackPort: number): Promise<Request> {
  const chunks: Uint8Array[] = []; let total = 0;
  for await (const chunk of incoming) {
    const bytes = typeof chunk === "string" ? new TextEncoder().encode(chunk) : chunk;
    total += bytes.length;
    if (total > 2 * 1024 * 1024) throw new RouterError("invalid_request", "Request body exceeds the 2 MiB local limit.", 413);
    chunks.push(bytes);
  }
  const body = chunks.length ? concat(chunks) : undefined;
  const url = `http://${incoming.headers.host ?? `${fallbackHost}:${fallbackPort}`}${incoming.url ?? "/"}`;
  return new Request(url, { method: incoming.method, headers: incoming.headers, body: body as any });
}
function concat(chunks: Uint8Array[]): Uint8Array {
  const output = new Uint8Array(chunks.reduce((sum, chunk) => sum + chunk.length, 0));
  let offset = 0; for (const chunk of chunks) { output.set(chunk, offset); offset += chunk.length; } return output;
}
function onceDrain(stream: any): Promise<void> {
  return new Promise((resolveDrain) => {
    const done = () => { stream.off("drain", done); stream.off("close", done); stream.off("error", done); resolveDrain(); };
    stream.once("drain", done); stream.once("close", done); stream.once("error", done);
  });
}
function positive(value: string | undefined, fallback: number): number { const parsed = Number(value); return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback; }
function loadEnvironment(base: Record<string, string | undefined>): Record<string, string | undefined> {
  const result = { ...base }; const path = result.BROKEROUTER_ENV_FILE ?? ".env";
  if (!existsSync(path)) return result;
  for (const rawLine of readFileSync(path, "utf8").split(/\r?\n/)) {
    const line = rawLine.trim(); if (!line || line.startsWith("#")) continue;
    const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!match) throw new Error("Environment file contains an unsupported line (value hidden)");
    if (result[match[1]] !== undefined) continue;
    let value = match[2].trim();
    if ((value.startsWith("'") && value.endsWith("'")) || (value.startsWith('"') && value.endsWith('"'))) value = value.slice(1, -1);
    result[match[1]] = value;
  }
  return result;
}
