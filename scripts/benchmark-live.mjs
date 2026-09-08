import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { cpus, platform, release } from "node:os";
import { join, relative } from "node:path";
import { performance } from "node:perf_hooks";

const baseUrl = required("BROKE_ROUTER_URL").replace(/\/$/, "");
const apiKey = required("BROKE_ROUTER_API_KEY");
const requestsPerRun = positiveInteger(process.env.BROKE_LIVE_REQUESTS, 40);
const repeats = positiveInteger(process.env.BROKE_LIVE_REPEATS, 3);
const concurrencyLevels = parseConcurrency(process.env.BROKE_LIVE_CONCURRENCY ?? "1,4,8,16");
const realRequests = nonNegativeInteger(process.env.BROKE_LIVE_REAL_REQUESTS, 0);
const outputDir = join(process.cwd(), "benchmarks", "results");
const accessHeaders = optionalHeaders({
  "cf-access-client-id": process.env.CF_ACCESS_CLIENT_ID,
  "cf-access-client-secret": process.env.CF_ACCESS_CLIENT_SECRET,
});
const authHeaders = { ...accessHeaders, authorization: `Bearer ${apiKey}` };
const jsonHeaders = { ...authHeaders, "content-type": "application/json" };
const benchmarkBody = JSON.stringify({
  model: "benchmark/echo",
  messages: [{ role: "user", content: "server benchmark" }],
  max_tokens: 16,
});
const routerPhases = [
  ["Workflow lookup", "br_workflow"],
  ["Caller quota inspect", "br_caller_inspect"],
  ["Atomic plan + reserve RPC", "br_plan_reserve"],
  ["Caller quota reserve", "br_caller_reserve"],
  ["Workflow lease", "br_workflow_lease"],
  ["Intentional inline wait", "br_inline_wait"],
  ["Response normalization", "br_normalize"],
  ["Unattributed router work", "br_other"],
];

console.log(`BrokeRouter live benchmark: ${baseUrl}`);
console.log(`${requestsPerRun} requests x ${repeats} repeats at concurrency ${concurrencyLevels.join(", ")}`);

const models = await getJson("/v1/models");
assert.ok(models.data?.some((model) => model.id === "benchmark/echo"),
  "benchmark/echo is unavailable. Deploy with BENCHMARK_PROVIDER_ENABLED=true.");
const policy = await getJson("/v1/routing/policy");
const statsBefore = await getJson("/v1/routing/stats");
const firstHealth = await single(`${baseUrl}/health`, { headers: accessHeaders });
const firstRouter = await single(`${baseUrl}/v1/chat/completions`, {
  method: "POST", headers: jsonHeaders, body: benchmarkBody,
});
assert.equal(firstRouter.status, 200, `First benchmark route returned ${firstRouter.status}`);
assert.equal(firstRouter.provider, "benchmark", "Explicit benchmark call did not use the benchmark provider");
await warmup(5);

const health = [];
const routed = [];
for (const concurrency of concurrencyLevels) {
  console.log(`Measuring deployed server path at concurrency ${concurrency}...`);
  health.push(await runRepeated("health", `${baseUrl}/health`, { headers: accessHeaders }, requestsPerRun, concurrency, repeats));
  routed.push(await runRepeated("router", `${baseUrl}/v1/chat/completions`, {
    method: "POST", headers: jsonHeaders, body: benchmarkBody,
  }, requestsPerRun, concurrency, repeats));
}

console.log("Measuring deployed streaming path...");
const streaming = await runStreaming(Math.max(12, Math.floor(requestsPerRun / 2)), 4, repeats);
const realProvider = realRequests > 0 ? await runRealProvider(realRequests) : undefined;
const expectedDecisionDelta = 1 + 5 + routed.reduce((sum, item) => sum + item.successful, 0) + streaming.successful
  + (realProvider?.successful ?? 0);
const statsAfter = await waitForStats(Number(statsBefore.decisions ?? 0) + expectedDecisionDelta);
const report = buildReport({
  models, policy, statsBefore, statsAfter, firstHealth, firstRouter, health, routed, streaming, realProvider,
});
await mkdir(outputDir, { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const jsonPath = join(outputDir, `live-${stamp}.json`);
const markdownPath = join(outputDir, `live-${stamp}.md`);
await Promise.all([
  writeFile(jsonPath, `${JSON.stringify(report, null, 2)}\n`, "utf8"),
  writeFile(markdownPath, renderMarkdown(report), "utf8"),
  writeFile(join(outputDir, "latest-live.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8"),
  writeFile(join(outputDir, "latest-live.md"), renderMarkdown(report), "utf8"),
]);
console.log(renderConsole(report));
console.log(`JSON: ${relative(process.cwd(), jsonPath)}`);
console.log(`Markdown: ${relative(process.cwd(), markdownPath)}`);

async function warmup(count) {
  for (let index = 0; index < count; index += 1) {
    const sample = await single(`${baseUrl}/v1/chat/completions`, {
      method: "POST", headers: jsonHeaders, body: benchmarkBody,
    });
    assert.equal(sample.status, 200, `Warmup returned ${sample.status}`);
  }
}

async function runRepeated(name, url, init, count, concurrency, repeatCount) {
  const runs = [];
  for (let repeat = 0; repeat < repeatCount; repeat += 1) runs.push(await runLoad(url, init, count, concurrency));
  return mergeRuns(name, concurrency, runs);
}

async function runLoad(url, init, count, concurrency) {
  let next = 0;
  const samples = [];
  const wallStarted = performance.now();
  async function client() {
    while (true) {
      const index = next++;
      if (index >= count) return;
      try { samples.push(await single(url, init)); }
      catch (error) { samples.push({ transportError: String(error), latencyMs: 0, bytes: 0 }); }
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, count) }, () => client()));
  return { samples, wallMs: performance.now() - wallStarted };
}

async function single(url, init) {
  const started = performance.now();
  const response = await fetch(url, { ...init, signal: AbortSignal.timeout(30_000) });
  const body = await response.arrayBuffer();
  const latencyMs = performance.now() - started;
  const serverTimingHeader = response.headers.get("server-timing") ?? undefined;
  const serverTiming = parseServerTiming(serverTimingHeader);
  const workerLatencyMs = serverTiming.br_total;
  const providerLatencyMs = serverTiming.br_provider;
  const routerLatencyMs = serverTiming.br_router;
  let completionValid;
  let finishReason;
  if (response.headers.get("content-type")?.includes("application/json")) {
    try {
      const payload = JSON.parse(new TextDecoder().decode(body));
      if (Array.isArray(payload.choices)) {
        const choice = payload.choices[0] ?? {};
        const message = choice.message ?? {};
        const visible = (typeof message.content === "string" && message.content.trim().length > 0)
          || (typeof message.refusal === "string" && message.refusal.trim().length > 0)
          || (Array.isArray(message.tool_calls) && message.tool_calls.length > 0)
          || Boolean(message.function_call);
        finishReason = choice.finish_reason;
        completionValid = visible && finishReason !== "length";
      }
    } catch { /* Non-completion JSON endpoints are measured without semantic fields. */ }
  }
  return {
    latencyMs,
    status: response.status,
    bytes: body.byteLength,
    provider: response.headers.get("x-broke-router-provider") ?? undefined,
    route: response.headers.get("x-broke-router-route") ?? undefined,
    attempts: Number(response.headers.get("x-broke-router-attempts")) || undefined,
    fallbackFrom: response.headers.get("x-broke-router-fallback-from") ?? undefined,
    policy: response.headers.get("x-broke-router-policy") ?? undefined,
    cfRay: response.headers.get("cf-ray") ?? undefined,
    colo: colo(response.headers.get("cf-ray")),
    serverTiming: serverTimingHeader,
    serverTimingMetrics: serverTiming,
    providerTimingMeasurement: response.headers.get("x-broke-router-provider-timing") ?? undefined,
    workerLatencyMs,
    providerLatencyMs,
    routerLatencyMs,
    clientCloudflareLatencyMs: finite(workerLatencyMs) ? Math.max(0, latencyMs - workerLatencyMs) : undefined,
    totalMinusProviderLatencyMs: finite(providerLatencyMs) ? Math.max(0, latencyMs - providerLatencyMs) : undefined,
    completionValid,
    finishReason,
  };
}

function mergeRuns(name, concurrency, runs) {
  const samples = runs.flatMap((run) => run.samples);
  const wallMs = runs.reduce((sum, run) => sum + run.wallMs, 0);
  const completed = samples.filter((sample) => !sample.transportError);
  const successful = completed.filter((sample) => sample.status < 400);
  const semanticFailures = successful.filter((sample) => sample.completionValid === false).length;
  const timed = successful.filter((sample) => finite(sample.workerLatencyMs)
    && finite(sample.providerLatencyMs) && finite(sample.routerLatencyMs));
  return {
    name, concurrency, repeats: runs.length, requests: samples.length, successful: successful.length,
    errors: samples.length - successful.length,
    errorRate: (samples.length - successful.length) / Math.max(1, samples.length),
    completedRequestsPerSecond: completed.length / (wallMs / 1_000),
    successfulRequestsPerSecond: successful.length / (wallMs / 1_000),
    latencyMs: summarize(completed.map((sample) => sample.latencyMs)),
    timingCoverage: { measured: timed.length, successful: successful.length },
    componentLatencyMs: {
      provider: summarize(timed.map((sample) => sample.providerLatencyMs)),
      router: summarize(timed.map((sample) => sample.routerLatencyMs)),
      workerTotal: summarize(timed.map((sample) => sample.workerLatencyMs)),
      clientCloudflare: summarize(timed.map((sample) => sample.clientCloudflareLatencyMs)),
      totalMinusProvider: summarize(timed.map((sample) => sample.totalMinusProviderLatencyMs)),
      phases: Object.fromEntries(routerPhases.map(([, key]) => [
        key,
        summarize(timed.map((sample) => sample.serverTimingMetrics?.[key]).filter(finite)),
      ])),
    },
    statusCounts: counts(completed.map((sample) => String(sample.status))),
    providers: counts(successful.map((sample) => sample.provider).filter(Boolean)),
    routes: counts(successful.map((sample) => sample.route).filter(Boolean)),
    fallbacks: successful.filter((sample) => sample.fallbackFrom).length,
    semanticFailures,
    policies: counts(successful.map((sample) => sample.policy).filter(Boolean)),
    colos: counts(successful.map((sample) => sample.colo).filter(Boolean)),
    runSuccessfulRequestsPerSecond: runs.map((run) => {
      const ok = run.samples.filter((sample) => !sample.transportError && sample.status < 400).length;
      return ok / (run.wallMs / 1_000);
    }),
  };
}

async function runStreaming(count, concurrency, repeatCount) {
  const ttft = [];
  const completion = [];
  const colos = [];
  let errors = 0;
  let totalWallMs = 0;
  const body = JSON.stringify({ ...JSON.parse(benchmarkBody), stream: true });
  for (let repeat = 0; repeat < repeatCount; repeat += 1) {
    let next = 0;
    const wallStarted = performance.now();
    async function client() {
      while (true) {
        const index = next++;
        if (index >= count) return;
        const started = performance.now();
        try {
          const response = await fetch(`${baseUrl}/v1/chat/completions`, {
            method: "POST", headers: jsonHeaders, body, signal: AbortSignal.timeout(30_000),
          });
          if (!response.ok || !response.body) { errors += 1; continue; }
          const reader = response.body.getReader();
          const first = await reader.read();
          if (first.done) { errors += 1; continue; }
          ttft.push(performance.now() - started);
          const region = colo(response.headers.get("cf-ray"));
          if (region) colos.push(region);
          while (!(await reader.read()).done) { /* drain */ }
          completion.push(performance.now() - started);
        } catch { errors += 1; }
      }
    }
    await Promise.all(Array.from({ length: Math.min(concurrency, count) }, () => client()));
    totalWallMs += performance.now() - wallStarted;
  }
  return {
    concurrency, repeats: repeatCount, requests: ttft.length + errors, successful: ttft.length, errors,
    errorRate: errors / Math.max(1, ttft.length + errors),
    successfulRequestsPerSecond: ttft.length / (totalWallMs / 1_000),
    timeToFirstTokenMs: summarize(ttft), completionLatencyMs: summarize(completion), colos: counts(colos),
  };
}

async function runRealProvider(count) {
  console.log(`Measuring ${count} quota-consuming free/default calls...`);
  const body = JSON.stringify({
    model: "free/default", messages: [{ role: "user", content: "Reply with exactly OK." }], max_tokens: 200,
  });
  const result = await runRepeated("real-provider", `${baseUrl}/v1/chat/completions`, {
    method: "POST", headers: jsonHeaders, body,
  }, count, 1, 1);
  assert.equal(result.semanticFailures, 0, "A real provider returned HTTP 200 without a complete visible answer");
  assert.equal(result.timingCoverage.measured, result.successful,
    "Provider timing is missing. Redeploy the instrumented Worker before running real-provider metrics.");
  return result;
}

async function getJson(path) {
  const response = await fetch(`${baseUrl}${path}`, { headers: authHeaders, signal: AbortSignal.timeout(30_000) });
  const text = await response.text();
  assert.ok(response.ok, `${path} returned ${response.status}: ${text.slice(0, 300)}`);
  return JSON.parse(text);
}

async function waitForStats(target) {
  const deadline = Date.now() + 30_000;
  let stats;
  do {
    stats = await getJson("/v1/routing/stats");
    if (Number(stats.decisions ?? 0) >= target && Number(stats.outcomes ?? 0) >= target) return stats;
    await new Promise((resolve) => setTimeout(resolve, 250));
  } while (Date.now() < deadline);
  throw new Error(`Routing telemetry did not reconcile to ${target} decisions/outcomes within 30 seconds`);
}

function buildReport(metrics) {
  const commit = spawnSync("git", ["rev-parse", "--short", "HEAD"], { encoding: "utf8" }).stdout.trim();
  const eligible = metrics.routed.filter((result) => result.errorRate <= 0.01);
  const fastest = [...eligible].sort((a, b) => b.successfulRequestsPerSecond - a.successfulRequestsPerSecond)[0];
  const curve = metrics.routed.map((router, index) => ({
    concurrency: router.concurrency,
    edgeHealthRequestsPerSecond: metrics.health[index].successfulRequestsPerSecond,
    routerRequestsPerSecond: router.successfulRequestsPerSecond,
    healthP50Ms: metrics.health[index].latencyMs.p50,
    routerP50Ms: router.latencyMs.p50,
    routerP95Ms: router.latencyMs.p95,
    routerP99Ms: router.latencyMs.p99,
    medianApplicationPathMs: Math.max(0, router.latencyMs.p50 - metrics.health[index].latencyMs.p50),
    measuredRouterP50Ms: router.componentLatencyMs.router.p50,
    measuredWorkerP50Ms: router.componentLatencyMs.workerTotal.p50,
    clientCloudflareP50Ms: router.componentLatencyMs.clientCloudflare.p50,
    errorRate: router.errorRate,
  }));
  return {
    schemaVersion: 2, generatedAt: new Date().toISOString(), gitCommit: commit, target: baseUrl,
    methodology: {
      type: "closed-loop deployed end-to-end server-path load test",
      requestsPerRun, repeats, concurrencyLevels,
      includes: ["client network", "Cloudflare edge", "Access when configured", "Worker authentication", "routing gates", "Durable Object RPC", "SQLite", "policy", "telemetry", "response normalization"],
      excludes: ["LLM inference for benchmark/echo", "provider Internet latency for benchmark/echo"],
      timingDefinitions: {
        endToEnd: "Client-observed request start through full response body.",
        provider: "Worker outbound provider invocation through full non-streaming response body; includes Cloudflare-to-provider network and provider service/inference.",
        router: "Worker request handling excluding measured provider duration; includes authentication, routing, Durable Object RPC, quota, policy, and normalization.",
        clientCloudflare: "Per-request end-to-end minus Worker total; includes client network, Cloudflare ingress/egress, scheduling before Worker execution, and response transfer.",
        totalMinusProvider: "Per-request end-to-end minus provider duration; equals router plus client/Cloudflare residual.",
      },
      realProviderRequests: realRequests,
    },
    system: { platform: platform(), release: release(), architecture: process.arch, node: process.version, cpuModel: cpus()[0]?.model ?? "unknown" },
    headline: {
      firstObservedHealthMs: metrics.firstHealth.latencyMs,
      firstObservedRouterMs: metrics.firstRouter.latencyMs,
      peakSuccessfulRequestsPerSecond: fastest?.successfulRequestsPerSecond ?? 0,
      peakConcurrency: fastest?.concurrency ?? 0,
      peakP50Ms: fastest?.latencyMs.p50 ?? 0,
      peakP95Ms: fastest?.latencyMs.p95 ?? 0,
      peakP99Ms: fastest?.latencyMs.p99 ?? 0,
      streamingP50TtftMs: metrics.streaming.timeToFirstTokenMs.p50,
      streamingP95TtftMs: metrics.streaming.timeToFirstTokenMs.p95,
      totalLoadErrors: metrics.routed.reduce((sum, item) => sum + item.errors, 0),
      totalLoadRequests: metrics.routed.reduce((sum, item) => sum + item.requests, 0),
      decisionDelta: Number(metrics.statsAfter.decisions ?? 0) - Number(metrics.statsBefore.decisions ?? 0),
      outcomeDelta: Number(metrics.statsAfter.outcomes ?? 0) - Number(metrics.statsBefore.outcomes ?? 0),
    },
    routingCurve: curve, policy: metrics.policy, scenarios: {
      health: metrics.health, benchmarkRouter: metrics.routed, streaming: metrics.streaming,
      realProvider: metrics.realProvider,
    },
    telemetry: { before: metrics.statsBefore, after: metrics.statsAfter },
  };
}

function renderMarkdown(report) {
  const h = report.headline;
  const rows = report.routingCurve.map((row) => `| ${row.concurrency} | ${fmt(row.edgeHealthRequestsPerSecond)} | ${fmt(row.routerRequestsPerSecond)} | ${fmt(row.healthP50Ms)} | ${fmt(row.routerP50Ms)} | ${fmt(row.routerP95Ms)} | ${fmt(row.routerP99Ms)} | ${fmt(row.medianApplicationPathMs)} | ${(row.errorRate * 100).toFixed(2)}% |`).join("\n");
  const real = report.scenarios.realProvider
    ? realProviderMarkdown(report.scenarios.realProvider)
    : "\n## Real-provider sample\n\nSkipped by default. Set `BROKE_LIVE_REAL_REQUESTS` to a small positive number to spend provider quota deliberately.\n";
  return `# BrokeRouter deployed benchmark\n\nGenerated ${report.generatedAt} against ${report.target} from commit \`${report.gitCommit}\`.\n\n## Headline metrics\n\n- Peak successful server-path throughput within a 1% error budget: **${fmt(h.peakSuccessfulRequestsPerSecond)} req/s** at concurrency ${h.peakConcurrency}.\n- Latency at that load: **${fmt(h.peakP50Ms)} ms p50**, **${fmt(h.peakP95Ms)} ms p95**, **${fmt(h.peakP99Ms)} ms p99**.\n- Streaming TTFT: **${fmt(h.streamingP50TtftMs)} ms p50**, **${fmt(h.streamingP95TtftMs)} ms p95**.\n- Errors: **${h.totalLoadErrors}/${h.totalLoadRequests}**.\n- Telemetry delta: **${h.decisionDelta} decisions / ${h.outcomeDelta} outcomes**.\n- First observed health/router requests: ${fmt(h.firstObservedHealthMs)} / ${fmt(h.firstObservedRouterMs)} ms. These are not guaranteed cold starts.\n\n## Saturation curve\n\n| Concurrency | Edge health req/s | Router req/s | Health p50 ms | Router p50 ms | Router p95 ms | Router p99 ms | Median application path ms | Errors |\n| ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |\n${rows}\n${real}\n## Claim boundary\n\nThe \`benchmark/echo\` path includes ${report.methodology.includes.join(", ")}. It excludes ${report.methodology.excludes.join(", ")}. The median application-path estimate subtracts health p50 from router p50 at equal concurrency; it is an approximation, not Cloudflare CPU time. Report the target region, commit, sample count, concurrency, percentile, and error rate with any claim.\n`;
}

function renderConsole(report) {
  const h = report.headline;
  const real = report.scenarios.realProvider;
  const breakdown = real ? `\n  Real-provider latency breakdown (mean | p50 | p95 | p99)\n${consoleTiming("End-to-end", real.latencyMs)}\n${consoleTiming("LLM provider round trip", real.componentLatencyMs.provider)}\n${consoleTiming("Total - LLM provider", real.componentLatencyMs.totalMinusProvider)}\n${consoleTiming("BrokeRouter only", real.componentLatencyMs.router)}\n${consoleTiming("Client + Cloudflare", real.componentLatencyMs.clientCloudflare)}\n` : "";
  const phases = real ? `\n  BrokeRouter phase breakdown (mean | p50 | p95 | p99)\n${routerPhases.map(([label, key]) => consoleTiming(label, real.componentLatencyMs.phases[key])).join("\n")}\n` : "";
  return `\nRESULTS\n  Peak successful server path: ${fmt(h.peakSuccessfulRequestsPerSecond)} req/s @ concurrency ${h.peakConcurrency}\n  Latency: p50 ${fmt(h.peakP50Ms)} ms | p95 ${fmt(h.peakP95Ms)} ms | p99 ${fmt(h.peakP99Ms)} ms\n  Streaming TTFT: p50 ${fmt(h.streamingP50TtftMs)} ms | p95 ${fmt(h.streamingP95TtftMs)} ms\n  Errors: ${h.totalLoadErrors}/${h.totalLoadRequests}\n  Telemetry: +${h.decisionDelta} decisions / +${h.outcomeDelta} outcomes\n${breakdown}${phases}`;
}

function realProviderMarkdown(real) {
  const rows = [
    ["End-to-end", real.latencyMs],
    ["LLM provider round trip", real.componentLatencyMs.provider],
    ["Total minus LLM provider", real.componentLatencyMs.totalMinusProvider],
    ["BrokeRouter only", real.componentLatencyMs.router],
    ["Client plus Cloudflare", real.componentLatencyMs.clientCloudflare],
  ].map(([name, metric]) => `| ${name} | ${fmt(metric.mean)} | ${fmt(metric.p50)} | ${fmt(metric.p95)} | ${fmt(metric.p99)} |`).join("\n");
  const phaseRows = routerPhases.map(([label, key]) => {
    const metric = real.componentLatencyMs.phases[key];
    return `| ${label} | ${fmt(metric.mean)} | ${fmt(metric.p50)} | ${fmt(metric.p95)} | ${fmt(metric.p99)} |`;
  }).join("\n");
  return `\n## Real-provider sample\n\n- Requests: ${real.requests}; errors: ${real.errors}; semantic failures: ${real.semanticFailures}.\n- Providers: \`${JSON.stringify(real.providers)}\`; routes: \`${JSON.stringify(real.routes)}\`; fallbacks: ${real.fallbacks}.\n- Timing coverage: ${real.timingCoverage.measured}/${real.timingCoverage.successful} successful requests.\n\n| Component | Mean ms | p50 ms | p95 ms | p99 ms |\n| --- | ---: | ---: | ---: | ---: |\n${rows}\n\n### BrokeRouter phase breakdown\n\n| Phase | Mean ms | p50 ms | p95 ms | p99 ms |\n| --- | ---: | ---: | ---: | ---: |\n${phaseRows}\n\nProvider time includes the Cloudflare-to-provider network plus provider queueing and inference. Percentiles are computed from each component's per-request samples; they are not obtained by subtracting independently calculated percentiles.\n`;
}

function consoleTiming(name, metric) {
  return `    ${name.padEnd(25)} ${fmt(metric.mean).padStart(8)} | ${fmt(metric.p50).padStart(8)} | ${fmt(metric.p95).padStart(8)} | ${fmt(metric.p99).padStart(8)} ms`;
}

function summarize(values) {
  if (!values.length) return { min: 0, mean: 0, p50: 0, p95: 0, p99: 0, max: 0, stddev: 0, mean95Ci: [0, 0] };
  const sorted = [...values].sort((a, b) => a - b);
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  const variance = values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / Math.max(1, values.length - 1);
  const stddev = Math.sqrt(variance);
  const margin = 1.96 * stddev / Math.sqrt(values.length);
  return { min: sorted[0], mean, p50: percentile(sorted, .5), p95: percentile(sorted, .95), p99: percentile(sorted, .99), max: sorted.at(-1), stddev, mean95Ci: [Math.max(0, mean - margin), mean + margin] };
}
function percentile(sorted, q) { const p = (sorted.length - 1) * q; const lo = Math.floor(p); const hi = Math.ceil(p); return sorted[lo] + (sorted[hi] - sorted[lo]) * (p - lo); }
function counts(values) { return values.reduce((result, value) => ({ ...result, [value]: (result[value] ?? 0) + 1 }), {}); }
function parseServerTiming(value) {
  if (!value) return {};
  const result = {};
  for (const entry of value.split(",")) {
    const name = entry.trim().split(";", 1)[0];
    const match = /(?:^|;)\s*dur=([0-9]+(?:\.[0-9]+)?)/i.exec(entry);
    if (name && match) result[name] = Number(match[1]);
  }
  return result;
}
function finite(value) { return typeof value === "number" && Number.isFinite(value); }
function colo(ray) { return ray?.includes("-") ? ray.slice(ray.lastIndexOf("-") + 1) : undefined; }
function optionalHeaders(record) { return Object.fromEntries(Object.entries(record).filter(([, value]) => typeof value === "string" && value.length)); }
function required(name) { const value = process.env[name]; if (!value) { console.error(`${name} is required.`); process.exit(1); } return value; }
function positiveInteger(value, fallback) { const parsed = Number(value); return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback; }
function nonNegativeInteger(value, fallback) { const parsed = Number(value); return Number.isInteger(parsed) && parsed >= 0 ? parsed : fallback; }
function parseConcurrency(value) { const parsed = [...new Set(value.split(",").map(Number).filter((item) => Number.isInteger(item) && item > 0))]; if (!parsed.length) throw new Error("BROKE_LIVE_CONCURRENCY must contain positive integers"); return parsed; }
function fmt(value) { return Number(value).toFixed(2); }
