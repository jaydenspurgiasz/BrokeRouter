# Private access model

BrokeRouter supports two private transports into one authoritative Worker:

```text
Cloudflare agent --Service Binding---------------------> BrokeRouter
Local agent ------Access-protected custom hostname----> BrokeRouter
```

Keep `workers_dev` disabled. The external route must be a custom hostname protected by a Cloudflare Access service-token policy. Access blocks unauthorized Internet traffic before the Worker runs. Every transport must additionally provide an independently revocable BrokeRouter caller credential; this identifies the application and grants endpoint scopes.

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

`ROUTER_API_KEY` remains a local migration fallback only when no caller registry is configured. If `CALLER_CREDENTIALS_JSON` exists, the legacy key is never considered. Production must use the caller registry.

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

Create a Cloudflare Access service token and a service-auth policy for the custom router hostname. A local request sends both transport credentials and its BrokeRouter caller token:

```http
CF-Access-Client-Id: <access-service-token-id>
CF-Access-Client-Secret: <access-service-token-secret>
Authorization: Bearer brk_local-laptop.<caller-secret>
```

Store these values in the operating system's credential store or injected environment variables. Provider API keys stay exclusively in BrokeRouter.

## Rotation and revocation

Generate a replacement credential, update the encrypted registry, deploy it, update the one caller, and remove the old entry. Disabling or deleting one record does not affect other agents. Use separate registries, Access applications, provider secrets, and Durable Object namespaces for staging and production.
