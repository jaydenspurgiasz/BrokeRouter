# Cloudflare deployment runbook

This runbook deploys two isolated services:

- Staging: `broke-router-staging`, with the deterministic `benchmark/echo` model enabled.
- Production: `broke-router`, with all diagnostic providers disabled.

Each service receives separate secrets and separate SQLite-backed Durable Object state for quotas,
jobs, workflows, policy events, and learned statistics.

## 1. Prerequisites

You need Node 22+, a Cloudflare account, and an active domain in Cloudflare DNS. Custom Domains
require a zone you own. From the repository:

```powershell
cd C:\Users\spurg\Documents\Projects\BrokeRouter
npm ci
npx wrangler login
npx wrangler whoami
npm run typecheck
npm test
npx wrangler deploy --env staging --dry-run
npx wrangler deploy --env= --dry-run
```

The Workers Free plan currently includes 100,000 requests/day and 10 ms CPU per HTTP invocation.
SQLite-backed Durable Objects are available on Free; their daily storage allowances are separate.

## 2. Put Custom Domains in source control

Choose unused hostnames such as `router-staging.example.com` and `router.example.com`. They must
not already have CNAME records. Add the production route at the top level of `wrangler.jsonc`:

```jsonc
"routes": [{ "pattern": "router.example.com", "custom_domain": true }]
```

Add the staging route inside `env.staging`:

```jsonc
"routes": [{ "pattern": "router-staging.example.com", "custom_domain": true }]
```

Keep `workers_dev: false`. Wrangler treats its configuration as the source of truth and will ask
Cloudflare to create DNS records and certificates when it deploys.

## 3. Generate independently revocable caller keys

Generate at least one staging operator, production operator, and production agent credential:

```powershell
npm run auth:key -- staging-operator --environment staging --admin
npm run auth:key -- local-laptop --environment production --admin
npm run auth:key -- coding-agent --environment production
```

Each command prints a caller token once and a registry entry containing only its SHA-256 hash.
Save the tokens in Windows Credential Manager or another secret store. Merge the staging entries
into one JSON object and the production entries into a different object. Never store the cleartext
tokens in either registry and never commit either value.

`--admin` grants `stats:read` and `policy:write`. Ordinary agent credentials deliberately cannot
change policy. Add caller-level request, token, daily, and concurrency limits to each registry entry
before deployment if desired; see `docs/security.md`.

## 4. Create the Workers and upload secrets

The first staging deploy creates the Worker, Durable Object namespaces, migrations, and Custom
Domain. The first production deploy does the same with isolated state:

```powershell
npx wrangler deploy --env staging
npx wrangler deploy --env=
```

Upload secrets independently. `wrangler secret put` reads the value interactively and creates a
new deployed Worker version; the value is encrypted and is not written to `wrangler.jsonc`.

```powershell
npx wrangler secret put NVIDIA_API_KEY --env staging
npx wrangler secret put GEMINI_API_KEY --env staging
npx wrangler secret put ADDITIONAL_OPENAI_COMPATIBLE_PROVIDERS_JSON --env staging
npx wrangler secret put CALLER_CREDENTIALS_JSON --env staging

npx wrangler secret put NVIDIA_API_KEY
npx wrangler secret put GEMINI_API_KEY
npx wrangler secret put ADDITIONAL_OPENAI_COMPATIBLE_PROVIDERS_JSON
npx wrangler secret put CALLER_CREDENTIALS_JSON
```

Use the same OpenAI-compatible provider JSON that passed local tests. A current Gemini example is:

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

The numeric limits above are conservative examples, not authoritative account quotas. Copy your
active RPM/TPM/RPD values from Google AI Studio and encode the known RPM/TPM limits here. Gemini
quotas are project-scoped and can change. The router learns authoritative 429 cooldowns at runtime.

After changing secrets, deploy once more so code, variables, and migrations are known to be current:

```powershell
npx wrangler deploy --env staging
npx wrangler deploy --env=
```

## 5. Protect the public hostnames with Cloudflare Access

In Zero Trust, create a self-hosted Access application for each exact hostname:

1. Go to **Zero Trust > Access controls > Applications**.
2. Add a **Self-hosted** application for `router-staging.example.com`.
3. Add a **Service Auth** policy. Do not use an Allow policy for machine-only access.
4. Repeat for `router.example.com`.
5. Go to **Access controls > Service credentials > Service Tokens**.
6. Create separate tokens for the laptop's staging and production access.
7. Copy each Client Secret immediately; Cloudflare displays it only once.
8. Add the matching service token to the corresponding application's Service Auth policy.

Every laptop request then supplies two independent layers:

```text
CF-Access-Client-Id: <transport identity>
CF-Access-Client-Secret: <transport secret>
Authorization: Bearer brk_<caller-id>.<caller-secret>
```

Access rejects unauthorized Internet traffic before the Worker runs. BrokeRouter's application key
then identifies the exact agent, scopes endpoints, applies caller quotas, and supports independent
revocation. Cloudflare-hosted agents should use a Service Binding instead of the public hostname;
they still send their BrokeRouter caller credential.

## 6. Verify staging before production

Set secrets only for the current PowerShell session:

```powershell
$env:BROKE_ROUTER_URL="https://router-staging.example.com"
$env:BROKE_ROUTER_API_KEY="brk_staging-operator.REPLACE_ME"
$env:CF_ACCESS_CLIENT_ID="REPLACE_ME.access"
$env:CF_ACCESS_CLIENT_SECRET="REPLACE_ME"
```

Verify transport, application authentication, and model registration:

```powershell
curl.exe -sS "$env:BROKE_ROUTER_URL/health" `
  -H "CF-Access-Client-Id: $env:CF_ACCESS_CLIENT_ID" `
  -H "CF-Access-Client-Secret: $env:CF_ACCESS_CLIENT_SECRET"

curl.exe -sS "$env:BROKE_ROUTER_URL/v1/models" `
  -H "CF-Access-Client-Id: $env:CF_ACCESS_CLIENT_ID" `
  -H "CF-Access-Client-Secret: $env:CF_ACCESS_CLIENT_SECRET" `
  -H "Authorization: Bearer $env:BROKE_ROUTER_API_KEY"
```

Staging must list `benchmark/echo`; production must not. Then run the deployed server benchmark:

```powershell
npm run benchmark:live
```

To add a deliberately small real-provider sample after the quota-free run passes:

```powershell
$env:BROKE_LIVE_REAL_REQUESTS="6"
npm run benchmark:live
```

Generated JSON and Markdown remain local under `benchmarks/results/` and are gitignored. See
`benchmarks/LIVE.md` for methodology and claim boundaries.

## 7. Deploy through GitHub after manual verification

The repository's manual `Deploy` workflow targets protected GitHub environments named `staging`
and `production`. In each GitHub environment, configure:

- `CLOUDFLARE_API_TOKEN`: create the **Edit Cloudflare Workers** token, then restrict it to the one account and required zone.
- `CLOUDFLARE_ACCOUNT_ID`.

Require a reviewer for the production environment. Deploy staging, run smoke and live benchmarks,
then approve production. Secrets already stored on the Worker are preserved across normal deploys.

## 8. Operate and roll back

Use the Cloudflare Worker dashboard for request counts, invocation status, subrequests, CPU, and
wall time. Use `npx wrangler tail broke-router-staging` while diagnosing staging. Application-level
metadata is available through:

```text
GET /v1/routing/stats
GET /v1/routing/policy
GET /v1/routing/evaluation
```

Keep the policy in `shadow` until the effective sample size and workflow outcomes are credible.
Policy rollback does not require a deployment:

```json
{"mode":"baseline","explorationRate":0,"minObservations":30}
```

Production code rollback should redeploy a known Git commit. Rotate one caller by adding its
replacement hash to `CALLER_CREDENTIALS_JSON`, updating that caller, and then removing the old hash.
