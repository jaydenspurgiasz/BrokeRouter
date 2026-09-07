# One-server Cloudflare deployment

BrokeRouter deploys as one personal Worker named `broke-router`. The initial version uses Cloudflare's
free `workers.dev` hostname and BrokeRouter's hashed caller authentication. A custom domain and
Cloudflare Access are optional later upgrades.

This build is Cloudflare-native, not a standalone Node.js server. It depends on Durable Object
bindings and their SQLite storage, so it cannot be copied directly onto an Oracle Cloud VM. An
Oracle deployment requires a separate runtime adapter plus replacements for quota, routing,
workflow, and job state (for example PostgreSQL/Redis and a durable job runner).

## 1. Log in and validate

```powershell
cd C:\Users\spurg\Documents\Projects\BrokeRouter
npm ci
npx wrangler login
npx wrangler whoami
npm run typecheck
npm test
npx wrangler deploy --dry-run
```

## 2. Generate caller credentials

Create one operator credential for the laptop and a separate least-privilege credential per agent:

```powershell
npm run auth:key -- local-laptop --admin
npm run auth:key -- coding-agent
```

Each command prints a caller token once and a registry entry containing only its SHA-256 hash. Save
the cleartext tokens in Windows Credential Manager or another secret store. Merge the registry
entries into one JSON object for `CALLER_CREDENTIALS_JSON`. Never commit either value.

## 3. Deploy once to create the Worker

```powershell
npm run deploy
```

Wrangler prints a URL similar to `https://broke-router.<account-subdomain>.workers.dev`. Save it as
your `BROKE_ROUTER_URL`. The deploy also creates the five Durable Object bindings and runs the
versioned SQLite migrations.

## 4. Upload secrets

```powershell
npx wrangler secret put BROKEROUTER_PROVIDER_ACCOUNT_NVIDIA_PRIMARY
npx wrangler secret put BROKEROUTER_PROVIDER_ACCOUNT_GEMINI_PRIMARY
npx wrangler secret put CALLER_CREDENTIALS_JSON
```

Paste each complete one-line account JSON value from the private `.env` interactively. The JSON,
including its API key, is stored as one encrypted Worker secret. Repeat the command with a unique
suffix for every additional account. A placeholder-only Gemini example is:

```json
{"provider":"gemini","endpoint":"https://generativelanguage.googleapis.com/v1beta/openai/chat/completions","apiKey":"replace-with-real-key-only-in-the-secret-prompt","models":[{"id":"free/default","upstreamModel":"gemini-3.5-flash-lite","contextWindow":1048576,"maxOutputTokens":65536,"supports":{"streaming":true,"tools":true,"structuredOutput":true,"vision":true},"tier":"balanced","free":true}],"rateLimits":{"dailySafetyBudgetTokens":0,"cooldownMs":900000,"requests":{"limit":5,"windowMs":60000},"tokens":{"limit":100000,"windowMs":60000},"maxConcurrent":1,"reservationTtlMs":120000}}
```

The rate limits are conservative examples. Replace them with the active RPM/TPM values shown in
Google AI Studio. The legacy `NVIDIA_API_KEY` and `ADDITIONAL_OPENAI_COMPATIBLE_PROVIDERS_JSON`
secrets remain supported for existing deployments, but are not needed for the account format.
Deploy once more after all secrets exist:

```powershell
npm run deploy
```

## 5. Verify

```powershell
$env:BROKE_ROUTER_URL="https://broke-router.YOUR-SUBDOMAIN.workers.dev"
$env:BROKE_ROUTER_API_KEY="brk_local-laptop.REPLACE_ME"

curl.exe -sS "$env:BROKE_ROUTER_URL/health"
curl.exe -sS "$env:BROKE_ROUTER_URL/v1/models" `
  -H "Authorization: Bearer $env:BROKE_ROUTER_API_KEY"
```

`/health` is intentionally public and contains no sensitive data. Every model, generation, job,
workflow, statistics, and policy endpoint requires the BrokeRouter credential. Provider secrets never
leave the Worker.

## 6. Benchmark the deployed server

The explicit `benchmark/echo` model cannot participate in automatic `free/default` routing. It runs
the real authentication, routing, Durable Object, SQLite, policy, streaming, and telemetry path
without spending provider quota:

```powershell
npm run benchmark:live
```

Then deliberately add six real provider calls:

```powershell
$env:BROKE_LIVE_REAL_REQUESTS="6"
npm run benchmark:live
```

Reports remain local under `benchmarks/results/`.

## 7. Connect a Cloudflare-hosted agent

Add a Service Binding to the agent Worker:

```json
{"services":[{"binding":"LLM_GATEWAY","service":"broke-router"}]}
```

Store that agent's distinct BrokeRouter token as its own Worker secret. Service Binding calls avoid
the public Internet path while preserving application authentication and per-caller quotas.

## 8. CI/CD and optional hardening

The manual GitHub `Deploy` workflow deploys this one Worker. Add `CLOUDFLARE_API_TOKEN` and
`CLOUDFLARE_ACCOUNT_ID` as GitHub Actions repository secrets.

Later, attach `router.example.com` as a Custom Domain, set `workers_dev` to `false`, and place a
Cloudflare Access Service Auth policy in front of it. That changes the transport boundary, not the
router API or caller registry.
