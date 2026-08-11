# One-server Cloudflare deployment

BrokeRouter currently deploys as one private personal service named `broke-router`. One Worker owns
the API, provider secrets, caller authentication, SQLite-backed Durable Objects, queues, workflows,
quota state, and routing telemetry. Additional environments can be introduced later without changing
the routing core.

## 1. Prerequisites

You need Node 22+, a Cloudflare account, and an active domain in Cloudflare DNS. From the repository:

```powershell
cd C:\Users\spurg\Documents\Projects\BrokeRouter
npm ci
npx wrangler login
npx wrangler whoami
npm run typecheck
npm test
npx wrangler deploy --dry-run
```

## 2. Attach one private hostname

Choose an unused hostname such as `router.example.com`. It must belong to your Cloudflare zone and
must not already have a conflicting CNAME. Add this top-level property to `wrangler.jsonc`:

```jsonc
"routes": [{ "pattern": "router.example.com", "custom_domain": true }]
```

Keep `workers_dev: false`. On deploy, Cloudflare creates the DNS record and TLS certificate.

## 3. Create personal caller credentials

Generate one operator credential for the laptop and a separate least-privilege credential for each
agent:

```powershell
npm run auth:key -- local-laptop --admin
npm run auth:key -- coding-agent
```

Each command prints a caller token once and a registry entry containing only its SHA-256 hash. Save
the cleartext tokens in Windows Credential Manager or another secret store. Merge the registry
entries into one JSON object for `CALLER_CREDENTIALS_JSON`. Never put the cleartext token in that
registry and never commit either value.

The operator receives statistics and policy-control scopes. An ordinary agent can use models, chat,
jobs, and workflows but cannot mutate routing policy. Optional caller-level request, token, daily,
and concurrency limits are documented in `docs/security.md`.

## 4. Deploy the Worker

```powershell
npm run deploy
```

This creates the Worker, five Durable Object bindings, SQLite migrations, and the Custom Domain.

## 5. Upload the four secrets

```powershell
npx wrangler secret put NVIDIA_API_KEY
npx wrangler secret put GEMINI_API_KEY
npx wrangler secret put ADDITIONAL_OPENAI_COMPATIBLE_PROVIDERS_JSON
npx wrangler secret put CALLER_CREDENTIALS_JSON
```

`wrangler secret put` reads the value interactively, encrypts it, and deploys a new Worker version.
Use the same provider registry JSON that passed local testing. A current Gemini example is:

```json
[
  {
    "id": "gemini",
    "endpoint": "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions",
    "apiKeyBinding": "GEMINI_API_KEY",
    "credentialScope": "primary",
    "rateLimits": {
      "requests": { "limit": 5, "windowMs": 60000 },
      "tokens": { "limit": 100000, "windowMs": 60000 },
      "maxConcurrent": 1
    },
    "models": [
      {
        "id": "free/default",
        "upstreamModel": "gemini-3.6-flash",
        "contextWindow": 1000000,
        "maxOutputTokens": 64000,
        "supports": { "streaming": true, "tools": true, "structuredOutput": true, "vision": true },
        "tier": "balanced",
        "free": true
      }
    ]
  }
]
```

The example limits are conservative, not authoritative. Copy the active RPM/TPM values from Google
AI Studio. Gemini quotas are project-scoped and may change; provider 429 responses remain
authoritative and produce persisted cooldowns.

Deploy once more after setting all secrets:

```powershell
npm run deploy
```

## 6. Protect the hostname with Cloudflare Access

1. Go to **Zero Trust > Access controls > Applications**.
2. Add a **Self-hosted** application for `router.example.com`.
3. Add a **Service Auth** policy. Do not use a human-login Allow policy for this machine API.
4. Go to **Access controls > Service credentials > Service Tokens**.
5. Create a token named `BrokeRouter Laptop` and choose an expiration period.
6. Copy the Client ID and Client Secret immediately; the secret is shown only once.
7. Add that service token to the application's Service Auth policy.

Laptop calls present both transport and application credentials:

```text
CF-Access-Client-Id: <transport identity>
CF-Access-Client-Secret: <transport secret>
Authorization: Bearer brk_<caller-id>.<caller-secret>
```

Access rejects unauthorized Internet traffic before the Worker runs. The BrokeRouter credential then
identifies the exact caller, grants scopes, applies caller quotas, and supports individual revocation.
Cloudflare-hosted agents should use a Service Binding instead of the public hostname; they still send
their own BrokeRouter credential.

## 7. Verify and benchmark

Set secrets only in the current PowerShell session:

```powershell
$env:BROKE_ROUTER_URL="https://router.example.com"
$env:BROKE_ROUTER_API_KEY="brk_local-laptop.REPLACE_ME"
$env:CF_ACCESS_CLIENT_ID="REPLACE_ME.access"
$env:CF_ACCESS_CLIENT_SECRET="REPLACE_ME"
```

Verify both authentication layers:

```powershell
curl.exe -sS "$env:BROKE_ROUTER_URL/health" `
  -H "CF-Access-Client-Id: $env:CF_ACCESS_CLIENT_ID" `
  -H "CF-Access-Client-Secret: $env:CF_ACCESS_CLIENT_SECRET"

curl.exe -sS "$env:BROKE_ROUTER_URL/v1/models" `
  -H "CF-Access-Client-Id: $env:CF_ACCESS_CLIENT_ID" `
  -H "CF-Access-Client-Secret: $env:CF_ACCESS_CLIENT_SECRET" `
  -H "Authorization: Bearer $env:BROKE_ROUTER_API_KEY"
```

The catalog includes `benchmark/echo`. It is diagnostic-only, cannot participate in automatic
`free/default` routing, and still requires a valid caller credential. Run the quota-free deployed
server benchmark:

```powershell
npm run benchmark:live
```

Then deliberately add a six-call real-provider sample:

```powershell
$env:BROKE_LIVE_REAL_REQUESTS="6"
npm run benchmark:live
```

Reports remain local under `benchmarks/results/`. See `benchmarks/LIVE.md` for methodology.

## 8. CI/CD and operations

The manual GitHub `Deploy` workflow runs typechecking and tests, then deploys this one Worker. Add
`CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` as GitHub Actions repository secrets. Create the
API token from the **Edit Cloudflare Workers** template and restrict it to this account and zone.

Use the Cloudflare Worker dashboard for request counts, invocation status, subrequests, CPU, and wall
time. Use `npx wrangler tail broke-router` for live diagnostics. Application metadata is available at:

```text
GET /v1/routing/stats
GET /v1/routing/policy
GET /v1/routing/evaluation
```

Policy rollback requires no deployment:

```json
{"mode":"baseline","explorationRate":0,"minObservations":30}
```

Code rollback redeploys a known Git commit. Credential rotation adds a replacement hash, updates the
one caller, then removes the old hash.
