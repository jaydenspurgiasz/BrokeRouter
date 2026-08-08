# BrokeRouter

Free-tier-aware LLM routing for agents that should not accidentally spend money. The first deployment target is Cloudflare Workers and the first provider is NVIDIA's API Catalog, but the routing core deliberately uses Web APIs and provider/state ports rather than Cloudflare or NVIDIA concepts.

## What exists

- OpenAI-compatible `POST /v1/chat/completions`, with streaming forwarded without buffering.
- `GET /v1/models` and `GET /health`.
- NVIDIA adapter using `https://integrate.api.nvidia.com/v1/chat/completions`.
- A SQLite-backed Durable Object that atomically enforces request windows, token windows, concurrent-call caps, a daily safety budget, and persisted cooldowns after upstream failures or 429s.
- A capability registry that refuses calls which would lose context, tools, streaming, or vision support.

The router does **not** own chat history, agent memory, prompt compaction, or tool execution. It preserves the entire request or fails clearly; an agent owns any compaction decision.

## Local setup

```bash
npm install
Copy-Item .dev.vars.example .dev.vars
# Set NVIDIA_API_KEY in .dev.vars
npm run dev
```

The NVIDIA key is only read in the gateway Worker. An agent deployed as another Worker should call this service through a Cloudflare Service Binding, not via the public Internet.

```ts
const response = await env.LLM_GATEWAY.fetch("https://broke-router/v1/chat/completions", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({
    model: "free/default",
    messages: [{ role: "user", content: "Hello" }],
    stream: true,
  }),
});
```

## Configuration

| Variable | Meaning |
| --- | --- |
| `NVIDIA_API_KEY` | Required Worker secret. Never expose to callers. |
| `ROUTER_API_KEY` | Optional bearer token required for public HTTP callers. Leave unset for Service-Binding-only use. |
| `NVIDIA_DAILY_SAFETY_BUDGET_TOKENS` | Local hard ceiling for a shared NVIDIA credential. `0` means no known daily ceiling is enforced; 429s still create cooldowns. |
| `NVIDIA_COOLDOWN_MS` | Conservative fallback cooldown when the upstream does not provide `Retry-After`. |
| `NVIDIA_REQUESTS_PER_WINDOW` + `NVIDIA_REQUEST_WINDOW_MS` | Optional request-rate ceiling. Set requests to `0` to disable predictive enforcement. |
| `NVIDIA_TOKENS_PER_WINDOW` + `NVIDIA_TOKEN_WINDOW_MS` | Optional reserved-token-rate ceiling. A request reserves estimated input plus requested output. |
| `NVIDIA_MAX_CONCURRENT` | Maximum in-flight calls using the shared NVIDIA credential. Defaults to `1` for conservative free-tier use. |
| `NVIDIA_RESERVATION_TTL_MS` | Recovery period for an in-flight reservation abandoned by a crashed invocation. |
| `MAX_INLINE_WAIT_MS` | Maximum time an interactive request may wait for the earliest slot before returning `503`. Defaults to 2 seconds. |

`NVIDIA_DAILY_SAFETY_BUDGET_TOKENS` is a local safety control, not a claim that NVIDIA provides that exact quota. The coordinator estimates and reserves input + requested maximum output before sending a call, then uses a provider error as authoritative evidence to halt attempts.

### Admission behavior

The gateway filters capable candidates first, then tries every eligible provider credential that can admit the request **now**. A provider that is in cooldown, above its request/token window, or at its concurrent-call cap is skipped. With only NVIDIA configured today, the gateway can wait only when the next slot opens within `MAX_INLINE_WAIT_MS`; otherwise it returns a `503` and `Retry-After`. This keeps interactive agent turns bounded. Durable queued work is intentionally a future asynchronous job adapter, rather than an HTTP request held open for minutes.

## Current model aliases

- `free/default` — text-oriented NVIDIA default.
- `nvidia/openai/gpt-oss-20b` — explicit version of the default.
- `vision/default` — NVIDIA-hosted vision-capable fallback.

Capability and context fields are stored in `src/core/models.ts`, intentionally as auditable configuration. Refresh them from provider documentation before relying on a changed model catalog.

## Adding another provider

1. Add its `ModelProfile` entries to the catalog.
2. Implement a provider adapter that turns a normalized request into its upstream format and normalizes rate-limit errors/usage.
3. Bind a state coordinator scope to that provider credential.
4. Extend policy scoring after capability filtering: context fit first, then quota headroom, cooldown/health, latency, and quality tier.

Do not add a provider by teaching the Cloudflare Worker vendor-specific routing rules. Keep that logic behind the provider and policy ports so a non-Cloudflare runtime can use the same core later.
