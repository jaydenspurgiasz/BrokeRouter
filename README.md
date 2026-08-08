# BrokeRouter

Free-tier-aware LLM routing for agents that should not accidentally spend money. The first deployment target is Cloudflare Workers and the first provider is NVIDIA's API Catalog, but the routing core deliberately uses Web APIs and provider/state ports rather than Cloudflare or NVIDIA concepts.

## What exists

- OpenAI-compatible `POST /v1/chat/completions`, with streaming forwarded without buffering.
- `GET /v1/models` and `GET /health`.
- NVIDIA adapter using `https://integrate.api.nvidia.com/v1/chat/completions`.
- A SQLite-backed Durable Object that atomically enforces request windows, token windows, concurrent-call caps, a daily safety budget, and persisted cooldowns after upstream failures or 429s.
- A capability registry that refuses calls which would lose context, tools, streaming, or vision support.

The router does **not** own chat history, agent memory, prompt compaction, or tool execution. It preserves the entire request or fails clearly; an agent owns any compaction decision.

## Deferred jobs

For non-interactive free-tier work, submit the same non-streaming chat request to `POST /v1/jobs`. It returns `202` and a `status_url`; poll that URL until the status is `completed` or `failed`. The queue is stored in a SQLite-backed Durable Object and scheduled with alarms, so it survives Worker restarts and waits for a rate-limit slot without holding an HTTP request open.

```text
POST /v1/jobs                 → { "id": "…", "status": "queued", "status_url": "/v1/jobs/…" }
GET  /v1/jobs/{id}            → queued | running | completed | failed
```

Jobs are deliberately non-streaming and currently execute through the NVIDIA adapter. They retry temporary upstream failures up to `ASYNC_JOB_MAX_ATTEMPTS` (default `5`), preserve only the request/result needed for completion, remove reasoning traces from completed results, and purge completed/failed jobs after `ASYNC_JOB_RETENTION_MS` (24 hours by default). Use synchronous chat completions for interactive agent turns.

## Provider options

NVIDIA thinking is available through the router's portable routing hint:

```json
{ "route": { "reasoning": "on" } }
```

It is off by default to protect free-tier output budgets. The router strips reasoning traces from returned responses even when reasoning is enabled; your agent receives the final answer and tool calls, not hidden chain-of-thought. Other provider-specific controls require an adapter-level option mapping before they are exposed as portable router fields.

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

The gateway uses persisted token buckets to calculate the earliest admission slot for configured request and token rates. For example, at one request per five seconds it can report a slot about two seconds away rather than waiting for a coarse window reset. It filters capable candidates first, then tries every eligible provider credential that can admit the request **now**. A provider that is in cooldown, above its request/token bucket, or at its concurrent-call cap is skipped. When none can admit, the gateway holds a bounded inline wait (the interactive queue) only when the earliest slot is within `MAX_INLINE_WAIT_MS`; otherwise it returns a `503` and `Retry-After`. This keeps interactive agent turns bounded rather than holding an HTTP connection for minutes.

## Additional providers

The NVIDIA adapter is built in. Add any provider with an OpenAI-compatible Chat Completions endpoint through `ADDITIONAL_OPENAI_COMPATIBLE_PROVIDERS_JSON`; its API key remains a Worker secret named by `apiKeyBinding`.

```json
[
  {
    "id": "groq",
    "endpoint": "https://api.groq.com/openai/v1/chat/completions",
    "apiKeyBinding": "GROQ_API_KEY",
    "credentialScope": "primary",
    "rateLimits": {
      "requests": { "limit": 30, "windowMs": 60000 },
      "tokens": { "limit": 6000, "windowMs": 60000 },
      "maxConcurrent": 2
    },
    "models": [
      {
        "id": "free/default",
        "upstreamModel": "your-provider-model-id",
        "contextWindow": 32000,
        "maxOutputTokens": 4096,
        "supports": { "streaming": true, "tools": true, "structuredOutput": false, "vision": false },
        "tier": "fast",
        "free": true
      }
    ]
  }
]
```

Declare `GROQ_API_KEY` as a secret, not in this JSON. Multiple configured providers share the request's routing candidate list but never share quota state: each `id` + `credentialScope` has its own coordinator. Replace the example model and limits with the provider's actual published capabilities and allowances.

`free/default` is a router alias: it considers every eligible free model. Provider configuration turns that entry into a unique explicit model ID—for example `gemini/free/default`—so a caller can force one provider during a diagnostic test.

## Integration smoke test

With `npm run dev -- --local` running and both NVIDIA and Gemini configured, run:

```bash
npm run test:integration
```

The test invokes the live local gateway and asserts health, provider catalog, forced NVIDIA and Gemini routes, streaming, reasoning-trace sanitization, and the async-job lifecycle. It spends a small amount of free-tier quota. Override `BROKE_ROUTER_URL` or `BROKE_ROUTER_API_KEY` when needed.

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
