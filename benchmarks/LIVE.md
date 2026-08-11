# Deployed Cloudflare benchmark

The live suite measures BrokeRouter as a server, not only as an LLM client. The private deployment exposes an
explicit `benchmark/echo` model that executes the real authentication, admission-control, policy,
Durable Object RPC, SQLite, telemetry, streaming, and response-normalization path without making an
LLM request. The model is excluded from `free/default` and requires an authenticated explicit request.

## Run

```powershell
$env:BROKE_ROUTER_URL="https://broke-router.YOUR-SUBDOMAIN.workers.dev"
$env:BROKE_ROUTER_API_KEY="brk_local-laptop.REPLACE_ME"
npm run benchmark:live
```

If a custom domain protected by Cloudflare Access is added later, also set
`CF_ACCESS_CLIENT_ID` and `CF_ACCESS_CLIENT_SECRET`; the harness includes them automatically.

Defaults:

- 40 requests per run and three repeats.
- Concurrency 1, 4, 8, and 16.
- Matching `/health` measurements to estimate client/edge overhead.
- JSON and SSE paths.
- Error-budget-aware successful throughput.
- p50, p95, p99, standard deviation, and 95% confidence interval data.
- Cloudflare colo counts from `CF-Ray`.
- Routing provider/policy distribution.
- Decision/outcome persistence reconciliation.
- No real LLM calls.

Override the load shape:

```powershell
$env:BROKE_LIVE_REQUESTS="100"
$env:BROKE_LIVE_REPEATS="5"
$env:BROKE_LIVE_CONCURRENCY="1,8,32,64"
npm run benchmark:live
```

Add a consciously bounded real-provider sample:

```powershell
$env:BROKE_LIVE_REAL_REQUESTS="6"
npm run benchmark:live
```

## Claim boundary

Client-observed latency includes the laptop network, Cloudflare edge, Access when configured, the
Worker, and Durable Objects. The report subtracts equal-concurrency health p50 from router p50 as an
approximate application-path cost; this is not Cloudflare CPU time. Use the Cloudflare dashboard or
Workers traces for CPU and wall-time evidence.

The quota-free benchmark does not measure NVIDIA/Gemini inference or provider networking. The
optional real-provider sample measures both and should always disclose its small sample count and
provider distribution. Never call the first observed request a guaranteed cold start because the
platform controls isolate reuse.

Reports are written to `benchmarks/results/latest-live.md` and `latest-live.json` and are ignored by
Git so they cannot accidentally capture a protected hostname or operational details.
