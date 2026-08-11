# Private access model

BrokeRouter supports two authenticated transports into one authoritative Worker:

```text
Cloudflare agent --Service Binding---------------------> BrokeRouter
Local agent ------workers.dev + caller credential-----> BrokeRouter
```

The personal MVP exposes a `workers.dev` hostname and requires an independently revocable BrokeRouter caller credential on every sensitive endpoint. This identifies the application, grants endpoint scopes, and prevents unauthorized provider use. A custom hostname protected by a Cloudflare Access service-token policy can later reject unauthorized traffic before the Worker runs.

## Caller credentials

Generate a high-entropy credential:

```powershell
npm run auth:key -- local-laptop --admin
```

The command prints the caller token once and a registry entry containing only its SHA-256 hash. Ordinary agent keys receive only model/chat/job/workflow scopes. Add `--admin` only for an operator key and `--paid` only when intentional spending is allowed. Combine entries into one JSON object and store it as the encrypted `CALLER_CREDENTIALS_JSON` Worker secret:

```powershell
npx wrangler secret put CALLER_CREDENTIALS_JSON
```

The registry record controls trusted caller identity, environment, enabled state, scopes, and optional caller-level admission limits. Application scopes are `models:read`, `chat:write`, `jobs:write`, `jobs:read`, `workflows:write`, and `workflows:read`. Observability/control scopes are `stats:read` and `policy:write`. The deliberately non-default `providers:paid` is required before `route.allowPaid` is honored. Do not accept caller identity from a request header.

Caller limits use the same strongly consistent request/token buckets, daily safety budget, concurrency leases, and crash-recovery TTL as provider admission. They prevent one runaway agent from exhausting shared provider capacity:

```json
{
  "coding-agent": {
    "keyHash": "<sha256>",
    "environment": "production",
    "scopes": ["chat:write", "jobs:write", "jobs:read", "workflows:write", "workflows:read"],
    "limits": {
      "requests": { "limit": 60, "windowMs": 60000 },
      "tokens": { "limit": 100000, "windowMs": 60000 },
      "dailySafetyBudgetTokens": 1000000,
      "maxConcurrent": 5,
      "reservationTtlMs": 120000
    }
  }
}
```

`ROUTER_API_KEY` remains a local migration fallback only when no caller registry is configured. If `CALLER_CREDENTIALS_JSON` exists, the legacy key is never considered. The deployed Worker must use the caller registry.

## Cloudflare agent

Add a Service Binding to the agent Worker:

```json
{
  "services": [
    { "binding": "LLM_GATEWAY", "service": "broke-router" }
  ]
}
```

Store that agent's distinct caller token as its own Worker secret and invoke:

```ts
await env.LLM_GATEWAY.fetch("https://broke-router/v1/chat/completions", {
  method: "POST",
  headers: {
    "content-type": "application/json",
    "authorization": `Bearer ${env.BROKE_ROUTER_CALLER_KEY}`,
  },
  body: JSON.stringify(request),
});
```

## Local agent

For the personal MVP, call the `workers.dev` URL with the laptop's BrokeRouter caller token:

```http
Authorization: Bearer brk_local-laptop.<caller-secret>
```

Store the token in the operating system's credential store or injected environment variables. Provider API keys stay exclusively in BrokeRouter. If Cloudflare Access is added later, also send its Client ID and Client Secret; the BrokeRouter token remains required.

## Rotation and revocation

Generate a replacement credential, update the encrypted registry, deploy it, update the one caller, and remove the old entry. Disabling or deleting one record does not affect other agents. If a second deployment environment is introduced later, give it separate registries, Access applications, provider secrets, and Durable Object namespaces.
