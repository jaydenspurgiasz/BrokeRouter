# Local performance benchmark

Run the actual Worker against two deterministic loopback OpenAI-compatible providers:

```powershell
npm run benchmark:local
```

The harness starts isolated Wrangler and Durable Object storage, disables every real provider, performs warmup, executes repeated closed-loop load tests, writes machine-readable JSON and a resume-friendly Markdown report under `benchmarks/results/`, then deletes all temporary state.

Default methodology:

- 50 requests per run.
- Three repeats.
- Concurrency 1, 4, 8, and 16.
- Direct mock-provider and full-router measurements at each concurrency.
- Health and model-catalog control baselines.
- Baseline, shadow, and adaptive policy comparisons.
- Streaming time to first token and completion latency.
- Workflow creation throughput.
- Bundle raw/gzip size and persisted learning counts.

Override the load shape without editing code:

```powershell
$env:BROKE_BENCH_REQUESTS="500"
$env:BROKE_BENCH_REPEATS="5"
$env:BROKE_BENCH_CONCURRENCY="1,8,32,64"
npm run benchmark:local
```

The conservative default is intended to remain stable in local Wrangler/Miniflare on Windows.
Use the overrides for stress and soak runs; very high local concurrency can measure the development
proxy's ceiling rather than Cloudflare's deployed runtime.

## Claim boundary

These results measure local gateway capacity and overhead: Node's HTTP client, workerd, authentication, gates, Durable Object RPC, SQLite, routing policy, response normalization, and a loopback upstream. They intentionally exclude Internet/TLS latency, provider queueing, and model inference/generation.

Do not present the result as LLM end-to-end latency or Cloudflare production cold-start performance. When quoting it, include the commit, hardware, concurrency, sample count, percentile, error rate, and the phrase "local deterministic mock providers."
