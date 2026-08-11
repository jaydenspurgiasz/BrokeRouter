# One-server Cloudflare deployment

BrokeRouter deploys as one personal Worker named `broke-router`. The initial version uses Cloudflare's
free `workers.dev` hostname and BrokeRouter's hashed caller authentication. A custom domain and
Cloudflare Access are optional later upgrades.

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
npx wrangler secret put NVIDIA_API_KEY
npx wrangler secret put GEMINI_API_KEY
npx wrangler secret put ADDITIONAL_OPENAI_COMPATIBLE_PROVIDERS_JSON
npx wrangler secret put CALLER_CREDENTIALS_JSON
```

Paste each value interactively. Use the provider registry JSON that passed local tests. A current
Gemini example is:

```json
[{"id":"gemini","endpoint":"https://generativelanguage.googleapis.com/v1beta/openai/chat/completions","apiKeyBinding":"GEMINI_API_KEY","credentialScope":"primary","rateLimits":{"requests":{"limit":5,"windowMs":60000},"tokens":{"limit":100000,"windowMs":60000},"maxConcurrent":1},"models":[{"id":"free/default","upstreamModel":"gemini-3.6-flash","contextWindow":1000000,"maxOutputTokens":64000,"supports":{"streaming":true,"tools":true,"structuredOutput":true,"vision":true},"tier":"balanced","free":true}]}]
```

The rate limits are conservative examples. Replace them with the active RPM/TPM values shown in
Google AI Studio. Deploy once more after all secrets exist:

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
