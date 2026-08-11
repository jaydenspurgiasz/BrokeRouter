import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { gzipSync } from "node:zlib";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { cpus, freemem, platform, release, tmpdir, totalmem } from "node:os";
import { join, relative } from "node:path";
import { performance } from "node:perf_hooks";

const workerPort = Number(process.env.BROKE_BENCH_PORT ?? "8794");
const baseUrl = `http://127.0.0.1:${workerPort}`;
const callerSecret = "local-benchmark-caller-secret-that-is-never-production";
const apiKey = `brk_benchmark.${callerSecret}`;
const callerRegistry = JSON.stringify({
  benchmark: {
    keyHash: createHash("sha256").update(callerSecret).digest("hex"),
    environment: "evaluation",
    scopes: ["models:read", "chat:write", "workflows:write", "workflows:read", "stats:read", "policy:write"],
  },
});
const headers = { authorization: `Bearer ${apiKey}`, "content-type": "application/json" };
const requestsPerRun = positiveInteger(process.env.BROKE_BENCH_REQUESTS, 50);
const repeats = positiveInteger(process.env.BROKE_BENCH_REPEATS, 3);
const concurrencyLevels = parseConcurrency(process.env.BROKE_BENCH_CONCURRENCY ?? "1,4,8,16");
const stateDir = await mkdtemp(join(tmpdir(), "broke-router-benchmark-state-"));
const bundleDir = await mkdtemp(join(tmpdir(), "broke-router-benchmark-bundle-"));
const outputDir = join(process.cwd(), "benchmarks", "results");
const mock = await startMockProvider();
const providerConfig = JSON.stringify([
  mockProvider("mock-a", `${mock.url}/v1/chat/completions?provider=mock-a`, "MOCK_A_KEY"),
  mockProvider("mock-b", `${mock.url}/v1/chat/completions?provider=mock-b`, "MOCK_B_KEY"),
]);
const workerStartedAt = performance.now();
const wrangler = spawn(process.execPath, [
  "node_modules/wrangler/bin/wrangler.js", "dev", "--local", "--port", String(workerPort),
  "--persist-to", stateDir, "--show-interactive-dev-session=false",
  "--var", "NVIDIA_ENABLED:false",
  "--var", `CALLER_CREDENTIALS_JSON:${callerRegistry}`,
  "--var", "NVIDIA_MAX_CONCURRENT:1000",
  "--var", "NVIDIA_REQUESTS_PER_WINDOW:0",
  "--var", "NVIDIA_TOKENS_PER_WINDOW:0",
  "--var", "ROUTING_POLICY_MODE:baseline",
  "--var", "ADAPTIVE_MIN_OBSERVATIONS:0",
  "--var", `ADDITIONAL_OPENAI_COMPATIBLE_PROVIDERS_JSON:${providerConfig}`,
  "--var", "MOCK_A_KEY:benchmark",
  "--var", "MOCK_B_KEY:benchmark",
], {
  cwd: process.cwd(), stdio: ["ignore", "pipe", "pipe"], windowsHide: true,
  env: { ...process.env, WRANGLER_LOG: "error" },
});

let workerOutput = "";
const captureWorkerOutput = (chunk) => { workerOutput = `${workerOutput}${chunk}`.slice(-64 * 1024); };
wrangler.stdout.on("data", captureWorkerOutput);
wrangler.stderr.on("data", captureWorkerOutput);

try {
  await waitForHealth();
  const localWorkerStartupMs = performance.now() - workerStartedAt;
  console.log(`BrokeRouter local benchmark: ${requestsPerRun} requests x ${repeats} repeats at concurrency ${concurrencyLevels.join(", ")}`);
  console.log(`Local Worker ready in ${format(localWorkerStartupMs)} ms. Warming routing state...`);

  const bundle = await bundleMetrics();
  const chatBody = JSON.stringify({
    model: "free/default", messages: [{ role: "user", content: "benchmark" }], max_tokens: 64,
  });
  const directBody = JSON.stringify({
    model: "mock-model", messages: [{ role: "user", content: "benchmark" }], max_tokens: 64,
  });

  const firstDirect = await singleLatency(`${mock.url}/v1/chat/completions`, { method: "POST", headers: { "content-type": "application/json" }, body: directBody });
  const firstRouter = await singleLatency(`${baseUrl}/v1/chat/completions`, { method: "POST", headers, body: chatBody });
  await warmup(`${baseUrl}/v1/chat/completions`, { method: "POST", headers, body: chatBody }, 25);

  console.log("Measuring HTTP/control-plane baselines...");
  const health = await runRepeated("health", `${baseUrl}/health`, { method: "GET" }, 300, 32, repeats);
  const models = await runRepeated("models", `${baseUrl}/v1/models`, {
    method: "GET", headers: { authorization: headers.authorization },
  }, 200, 32, repeats);

  const direct = [];
  const routed = [];
  for (const concurrency of concurrencyLevels) {
    console.log(`Measuring direct mock and full router at concurrency ${concurrency}...`);
    direct.push(await runRepeated(`direct-c${concurrency}`, `${mock.url}/v1/chat/completions`, {
      method: "POST", headers: { "content-type": "application/json" }, body: directBody,
    }, requestsPerRun, concurrency, repeats));
    routed.push(await runRepeated(`router-c${concurrency}`, `${baseUrl}/v1/chat/completions`, {
      method: "POST", headers, body: chatBody,
    }, requestsPerRun, concurrency, repeats));
  }

  console.log("Measuring policy modes, streaming TTFT, and workflow control plane...");
  const policyModes = [];
  for (const mode of ["baseline", "shadow", "adaptive"]) {
    await setPolicy(mode);
    policyModes.push(await runRepeated(`policy-${mode}`, `${baseUrl}/v1/chat/completions`, {
      method: "POST", headers, body: chatBody,
    }, Math.max(10, Math.floor(requestsPerRun / 2)), 16, repeats));
  }
  await setPolicy("baseline");
  const streaming = await runStreamingRepeated(chatBody, Math.max(10, Math.floor(requestsPerRun / 4)), 8, repeats);
  const workflows = await runRepeated("workflow-create", `${baseUrl}/v1/workflows`, {
    method: "POST", headers,
    body: JSON.stringify({
      workflowType: "coding-agent", expectedCalls: 5, maxCalls: 8, maxConcurrency: 3,
      estimatedTotalTokens: 20_000, qualityTier: "balanced", priority: 50,
    }),
  }, Math.max(10, Math.floor(requestsPerRun / 4)), 16, repeats);

  await sleep(500);
  const learned = await fetchJson(`${baseUrl}/v1/routing/stats`, { headers: { authorization: headers.authorization } });
  const evaluation = await fetchJson(`${baseUrl}/v1/routing/evaluation`, { headers: { authorization: headers.authorization } });
  const report = buildReport({
    localWorkerStartupMs, firstDirect, firstRouter, bundle, health, models, direct, routed,
    policyModes, streaming, workflows, learned, evaluation,
  });
  await mkdir(outputDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const jsonPath = join(outputDir, `local-${stamp}.json`);
  const markdownPath = join(outputDir, `local-${stamp}.md`);
  await Promise.all([
    writeFile(jsonPath, `${JSON.stringify(report, null, 2)}\n`, "utf8"),
    writeFile(markdownPath, renderMarkdown(report), "utf8"),
    writeFile(join(outputDir, "latest.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8"),
    writeFile(join(outputDir, "latest.md"), renderMarkdown(report), "utf8"),
  ]);
  console.log(renderConsoleSummary(report));
  console.log(`JSON: ${relative(process.cwd(), jsonPath)}`);
  console.log(`Markdown: ${relative(process.cwd(), markdownPath)}`);
} catch (error) {
  console.error(`\nBenchmark failed. Wrangler/workerd tail:\n${workerOutput.slice(-8_000)}`);
  throw error;
} finally {
  await stopWorker();
  await mock.close();
  await removeDirectory(stateDir);
  await removeDirectory(bundleDir);
}

function mockProvider(id, endpoint, apiKeyBinding) {
  return {
    id, endpoint, apiKeyBinding, credentialScope: "benchmark",
    // A loopback transport hiccup must not poison later scenarios with the inherited
    // production provider cooldown. We still count the failed request itself.
    rateLimits: { maxConcurrent: 1000, cooldownMs: 1, reservationTtlMs: 10_000 },
    models: [{
      id: "free/default", upstreamModel: "mock-model", contextWindow: 128_000,
      maxOutputTokens: 8_192,
      supports: { streaming: true, tools: true, structuredOutput: true, vision: false },
      tier: "balanced", free: true,
    }],
  };
}

async function startMockProvider() {
  const server = createServer(async (request, response) => {
    if (request.method !== "POST" || !request.url?.startsWith("/v1/chat/completions")) {
      response.writeHead(404).end();
      return;
    }
    try {
      const body = JSON.parse(await readBody(request));
      const provider = new URL(request.url, "http://localhost").searchParams.get("provider") ?? "direct";
      if (body.stream) {
        response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
        response.write(`data: ${JSON.stringify({ id: "mock-stream", choices: [{ index: 0, delta: { role: "assistant", content: "OK" } }] })}\n\n`);
        setTimeout(() => response.end("data: [DONE]\n\n"), 2);
        return;
      }
      response.writeHead(200, { "content-type": "application/json", "x-mock-provider": provider });
      response.end(JSON.stringify({
        id: `mock-${provider}`, object: "chat.completion", created: Math.floor(Date.now() / 1_000),
        model: "mock-model", choices: [{ index: 0, message: { role: "assistant", content: "OK" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 8, completion_tokens: 2, total_tokens: 10 },
      }));
    } catch (error) {
      response.writeHead(400, { "content-type": "application/json" }).end(JSON.stringify({ error: String(error) }));
    }
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Mock provider did not bind a TCP port");
  return {
    url: `http://127.0.0.1:${address.port}`,
    close: () => new Promise((resolve) => {
      server.close(resolve);
      server.closeAllConnections();
    }),
  };
}

async function waitForHealth() {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${baseUrl}/health`);
      if (response.ok) return;
    } catch { /* Wrangler is starting. */ }
    await sleep(100);
  }
  throw new Error(`Worker did not start within 30 seconds.\n${workerOutput.slice(-3_000)}`);
}

async function warmup(url, init, count) {
  for (let index = 0; index < count; index += 1) {
    const response = await fetch(url, init);
    await response.arrayBuffer();
    if (!response.ok) throw new Error(`Warmup failed with HTTP ${response.status}`);
  }
}

async function singleLatency(url, init) {
  const started = performance.now();
  const response = await fetch(url, init);
  const body = await response.arrayBuffer();
  return { latencyMs: performance.now() - started, status: response.status, bytes: body.byteLength };
}

async function runRepeated(name, url, init, requestCount, concurrency, repeatCount) {
  const runs = [];
  for (let repeat = 0; repeat < repeatCount; repeat += 1) {
    runs.push(await runLoad(url, init, requestCount, concurrency));
  }
  return mergeRuns(name, concurrency, runs);
}

async function runLoad(url, init, requestCount, concurrency) {
  const latencies = [];
  const statusCounts = {};
  const providers = {};
  let bytes = 0;
  let next = 0;
  let transportErrors = 0;
  const wallStarted = performance.now();
  async function client() {
    while (true) {
      const index = next++;
      if (index >= requestCount) return;
      const started = performance.now();
      try {
        const response = await fetch(url, init);
        const body = await response.arrayBuffer();
        latencies.push(performance.now() - started);
        bytes += body.byteLength;
        statusCounts[response.status] = (statusCounts[response.status] ?? 0) + 1;
        const provider = response.headers.get("x-broke-router-provider");
        if (provider) providers[provider] = (providers[provider] ?? 0) + 1;
      } catch {
        transportErrors += 1;
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, requestCount) }, () => client()));
  return { latencies, statusCounts, providers, bytes, transportErrors, wallMs: performance.now() - wallStarted };
}

function mergeRuns(name, concurrency, runs) {
  const latencies = runs.flatMap((run) => run.latencies);
  const wallMs = runs.reduce((total, run) => total + run.wallMs, 0);
  const statusCounts = mergeCounts(runs.map((run) => run.statusCounts));
  const providers = mergeCounts(runs.map((run) => run.providers));
  const transportErrors = runs.reduce((total, run) => total + run.transportErrors, 0);
  const bytes = runs.reduce((total, run) => total + run.bytes, 0);
  const successful = Object.entries(statusCounts).reduce((total, [status, count]) => total + (Number(status) < 400 ? count : 0), 0);
  return {
    name, concurrency, repeats: runs.length, requests: latencies.length + transportErrors,
    successful, errors: latencies.length + transportErrors - successful,
    errorRate: (latencies.length + transportErrors - successful) / Math.max(1, latencies.length + transportErrors),
    requestsPerSecond: latencies.length / (wallMs / 1_000),
    successfulRequestsPerSecond: successful / (wallMs / 1_000),
    throughputMiBPerSecond: bytes / (1024 * 1024) / (wallMs / 1_000),
    latencyMs: summarize(latencies), statusCounts, providers,
    runRequestsPerSecond: runs.map((run) => run.latencies.length / (run.wallMs / 1_000)),
  };
}

async function runStreamingRepeated(chatBody, requestCount, concurrency, repeatCount) {
  const runs = [];
  const streamingBody = JSON.stringify({ ...JSON.parse(chatBody), stream: true });
  for (let repeat = 0; repeat < repeatCount; repeat += 1) {
    runs.push(await runStreaming(requestCount, concurrency, streamingBody));
  }
  const ttft = runs.flatMap((run) => run.ttft);
  const complete = runs.flatMap((run) => run.complete);
  const wallMs = runs.reduce((total, run) => total + run.wallMs, 0);
  const errors = runs.reduce((total, run) => total + run.errors, 0);
  return {
    name: "streaming", concurrency, repeats: repeatCount, requests: ttft.length + errors,
    successful: ttft.length, errors, errorRate: errors / Math.max(1, ttft.length + errors),
    requestsPerSecond: ttft.length / (wallMs / 1_000),
    timeToFirstTokenMs: summarize(ttft), completionLatencyMs: summarize(complete),
  };

  async function runStreaming(count, clients, body) {
    let next = 0;
    let errors = 0;
    const ttft = [];
    const complete = [];
    const wallStarted = performance.now();
    async function client() {
      while (true) {
        const index = next++;
        if (index >= count) return;
        const started = performance.now();
        try {
          const response = await fetch(`${baseUrl}/v1/chat/completions`, { method: "POST", headers, body });
          if (!response.ok || !response.body) { errors += 1; continue; }
          const reader = response.body.getReader();
          const first = await reader.read();
          if (first.done) { errors += 1; continue; }
          ttft.push(performance.now() - started);
          while (!(await reader.read()).done) { /* drain */ }
          complete.push(performance.now() - started);
        } catch { errors += 1; }
      }
    }
    await Promise.all(Array.from({ length: Math.min(clients, count) }, () => client()));
    return { ttft, complete, errors, wallMs: performance.now() - wallStarted };
  }
}

async function setPolicy(mode) {
  const response = await fetch(`${baseUrl}/v1/routing/policy`, {
    method: "PUT", headers,
    body: JSON.stringify({ mode, explorationRate: 0, minObservations: 0 }),
  });
  if (!response.ok) throw new Error(`Could not set ${mode} policy: HTTP ${response.status}`);
  await response.arrayBuffer();
}

async function bundleMetrics() {
  const result = spawnSync(process.execPath, [
    "node_modules/wrangler/bin/wrangler.js", "deploy", "--dry-run", "--outdir", bundleDir,
  ], { cwd: process.cwd(), encoding: "utf8", windowsHide: true });
  if (result.status !== 0) throw new Error(`Wrangler bundle dry run failed:\n${result.stderr || result.stdout}`);
  const files = await listFiles(bundleDir);
  let rawBytes = 0;
  let gzipBytes = 0;
  for (const file of files) {
    const data = await readFile(file);
    rawBytes += data.byteLength;
    gzipBytes += gzipSync(data).byteLength;
  }
  return { files: files.length, rawBytes, gzipBytes };
}

function buildReport(metrics) {
  const commit = spawnSync("git", ["rev-parse", "--short", "HEAD"], { cwd: process.cwd(), encoding: "utf8", windowsHide: true }).stdout.trim();
  const withinErrorBudget = metrics.routed.filter((result) => result.errorRate <= 0.01);
  const fastest = [...(withinErrorBudget.length ? withinErrorBudget : metrics.routed)]
    .sort((left, right) => right.successfulRequestsPerSecond - left.successfulRequestsPerSecond)[0];
  const curve = metrics.routed.map((router, index) => ({
    concurrency: router.concurrency,
    directRequestsPerSecond: metrics.direct[index].requestsPerSecond,
    routerRequestsPerSecond: router.requestsPerSecond,
    successfulRouterRequestsPerSecond: router.successfulRequestsPerSecond,
    routerP50Ms: router.latencyMs.p50,
    routerP95Ms: router.latencyMs.p95,
    routerP99Ms: router.latencyMs.p99,
    medianRouterOverheadMs: Math.max(0, router.latencyMs.p50 - metrics.direct[index].latencyMs.p50),
    errorRate: router.errorRate,
  }));
  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    gitCommit: commit,
    methodology: {
      type: "closed-loop local end-to-end load test",
      requestsPerRun, repeats, concurrencyLevels,
      provider: "two loopback OpenAI-compatible mock providers with deterministic 0 ms inference delay",
      includes: ["Node HTTP client", "workerd", "authentication", "routing gates", "Durable Object RPC", "SQLite", "policy", "loopback upstream", "response normalization"],
      excludes: ["Internet latency", "TLS to a remote provider", "provider queueing", "model inference/generation"],
    },
    system: {
      platform: platform(), release: release(), architecture: process.arch, node: process.version,
      cpuModel: cpus()[0]?.model ?? "unknown", logicalCpus: cpus().length,
      totalMemoryGiB: totalmem() / 1024 ** 3, freeMemoryGiBAtEnd: freemem() / 1024 ** 3,
    },
    headline: {
      localWorkerStartupMs: metrics.localWorkerStartupMs,
      firstDirectRequestMs: metrics.firstDirect.latencyMs,
      firstRoutedRequestMs: metrics.firstRouter.latencyMs,
      fastestMeasuredRouterRequestsPerSecond: fastest.successfulRequestsPerSecond,
      fastestMeasuredAtConcurrency: fastest.concurrency,
      fastestMeasuredErrorRate: fastest.errorRate,
      p50LatencyAtFastestRpsMs: fastest.latencyMs.p50,
      p95LatencyAtFastestRpsMs: fastest.latencyMs.p95,
      p99LatencyAtFastestRpsMs: fastest.latencyMs.p99,
      streamingP50TtftMs: metrics.streaming.timeToFirstTokenMs.p50,
      streamingP95TtftMs: metrics.streaming.timeToFirstTokenMs.p95,
      fullRouterErrors: metrics.routed.reduce((sum, result) => sum + result.errors, 0),
      fullRouterRequests: metrics.routed.reduce((sum, result) => sum + result.requests, 0),
      bundleRawKiB: metrics.bundle.rawBytes / 1024,
      bundleGzipKiB: metrics.bundle.gzipBytes / 1024,
      learnedDecisions: Number(metrics.learned.decisions ?? 0),
      learnedOutcomes: Number(metrics.learned.outcomes ?? 0),
    },
    routingCurve: curve,
    scenarios: {
      health: metrics.health,
      models: metrics.models,
      directUpstream: metrics.direct,
      fullRouter: metrics.routed,
      policyModes: metrics.policyModes,
      streaming: metrics.streaming,
      workflowCreation: metrics.workflows,
    },
    bundle: metrics.bundle,
    learnedState: metrics.learned,
    shadowEvaluation: metrics.evaluation,
  };
}

function renderMarkdown(report) {
  const h = report.headline;
  const rows = report.routingCurve.map((row) => `| ${row.concurrency} | ${format(row.directRequestsPerSecond)} | ${format(row.routerRequestsPerSecond)} | ${format(row.successfulRouterRequestsPerSecond)} | ${format(row.routerP50Ms)} | ${format(row.routerP95Ms)} | ${format(row.routerP99Ms)} | ${format(row.medianRouterOverheadMs)} | ${(row.errorRate * 100).toFixed(2)}% |`).join("\n");
  const modes = report.scenarios.policyModes.map((mode) => `| ${mode.name.replace("policy-", "")} | ${format(mode.requestsPerSecond)} | ${format(mode.latencyMs.p50)} | ${format(mode.latencyMs.p95)} | ${format(mode.latencyMs.p99)} | ${(mode.errorRate * 100).toFixed(2)}% |`).join("\n");
  return `# BrokeRouter local benchmark\n\nGenerated ${report.generatedAt} from commit \`${report.gitCommit}\`.\n\n## Headline metrics\n\n- Peak measured successful full-router throughput within a 1% error budget: **${format(h.fastestMeasuredRouterRequestsPerSecond)} requests/s** at concurrency ${h.fastestMeasuredAtConcurrency} (${(h.fastestMeasuredErrorRate * 100).toFixed(2)}% errors).\n- Latency at that load: **${format(h.p50LatencyAtFastestRpsMs)} ms p50**, **${format(h.p95LatencyAtFastestRpsMs)} ms p95**, **${format(h.p99LatencyAtFastestRpsMs)} ms p99**.\n- Streaming time to first token: **${format(h.streamingP50TtftMs)} ms p50**, **${format(h.streamingP95TtftMs)} ms p95**.\n- Full-router errors: **${h.fullRouterErrors}/${h.fullRouterRequests}**.\n- Worker bundle: **${format(h.bundleRawKiB)} KiB raw**, **${format(h.bundleGzipKiB)} KiB gzip**.\n- Metadata reconciled: **${h.learnedDecisions} decisions**, **${h.learnedOutcomes} outcomes**.\n\n## Routing saturation curve\n\n| Concurrency | Direct mock req/s | Completed router req/s | Successful router req/s | Router p50 ms | Router p95 ms | Router p99 ms | Median router overhead ms | Errors |\n| ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |\n${rows}\n\n## Policy-mode cost\n\n| Mode | Requests/s | p50 ms | p95 ms | p99 ms | Errors |\n| --- | ---: | ---: | ---: | ---: | ---: |\n${modes}\n\n## Other control-plane metrics\n\n- Local Wrangler/workerd startup: ${format(h.localWorkerStartupMs)} ms. This is **not** a Cloudflare production cold-start claim.\n- First direct mock request: ${format(h.firstDirectRequestMs)} ms.\n- First routed request after health readiness: ${format(h.firstRoutedRequestMs)} ms.\n- Models endpoint: ${format(report.scenarios.models.requestsPerSecond)} req/s, ${format(report.scenarios.models.latencyMs.p95)} ms p95.\n- Workflow creation: ${format(report.scenarios.workflowCreation.requestsPerSecond)} req/s, ${format(report.scenarios.workflowCreation.latencyMs.p95)} ms p95.\n- Streaming completion: ${format(report.scenarios.streaming.completionLatencyMs.p50)} ms p50, ${format(report.scenarios.streaming.completionLatencyMs.p95)} ms p95.\n\n## Methodology and claim boundary\n\nThis is a ${report.methodology.type} with ${report.methodology.requestsPerRun} requests per run, ${report.methodology.repeats} repeats, and concurrency levels ${report.methodology.concurrencyLevels.join(", ")}. It uses ${report.methodology.provider}.\n\nThe full-router measurement includes ${report.methodology.includes.join(", ")}. It excludes ${report.methodology.excludes.join(", ")}. Therefore these numbers measure **gateway overhead and local capacity**, not real LLM end-to-end response latency. Run the same command on a quiet machine and report the hardware and commit with any resume claim.\n\n## Machine\n\n- ${report.system.cpuModel} (${report.system.logicalCpus} logical CPUs)\n- ${report.system.platform} ${report.system.release}, ${report.system.architecture}\n- Node ${report.system.node}\n- ${format(report.system.totalMemoryGiB)} GiB RAM\n`;
}

function renderConsoleSummary(report) {
  const h = report.headline;
  return `\nRESULTS\n  Peak full-router throughput: ${format(h.fastestMeasuredRouterRequestsPerSecond)} req/s @ concurrency ${h.fastestMeasuredAtConcurrency}\n  Latency at peak: p50 ${format(h.p50LatencyAtFastestRpsMs)} ms | p95 ${format(h.p95LatencyAtFastestRpsMs)} ms | p99 ${format(h.p99LatencyAtFastestRpsMs)} ms\n  Streaming TTFT: p50 ${format(h.streamingP50TtftMs)} ms | p95 ${format(h.streamingP95TtftMs)} ms\n  Router errors: ${h.fullRouterErrors}/${h.fullRouterRequests}\n  Bundle: ${format(h.bundleGzipKiB)} KiB gzip\n`;
}

function summarize(values) {
  if (!values.length) return { min: 0, mean: 0, p50: 0, p95: 0, p99: 0, max: 0, stddev: 0, coefficientOfVariation: 0, mean95Ci: [0, 0] };
  const sorted = [...values].sort((left, right) => left - right);
  const mean = values.reduce((total, value) => total + value, 0) / values.length;
  const variance = values.reduce((total, value) => total + (value - mean) ** 2, 0) / Math.max(1, values.length - 1);
  const stddev = Math.sqrt(variance);
  const margin = 1.96 * stddev / Math.sqrt(values.length);
  return {
    min: sorted[0], mean, p50: percentile(sorted, 0.5), p95: percentile(sorted, 0.95),
    p99: percentile(sorted, 0.99), max: sorted.at(-1), stddev,
    coefficientOfVariation: mean ? stddev / mean : 0,
    mean95Ci: [Math.max(0, mean - margin), mean + margin],
  };
}

function percentile(sorted, quantile) {
  const position = (sorted.length - 1) * quantile;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  return lower === upper ? sorted[lower] : sorted[lower] + (sorted[upper] - sorted[lower]) * (position - lower);
}

function mergeCounts(values) {
  const merged = {};
  for (const value of values) for (const [key, count] of Object.entries(value)) merged[key] = (merged[key] ?? 0) + count;
  return merged;
}

async function fetchJson(url, init) {
  const response = await fetch(url, init);
  const text = await response.text();
  if (!response.ok) throw new Error(`${url} returned HTTP ${response.status}: ${text.slice(0, 500)}`);
  return JSON.parse(text);
}

async function readBody(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

async function listFiles(directory) {
  const output = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) output.push(...await listFiles(path));
    else if ((await stat(path)).isFile()) output.push(path);
  }
  return output;
}

async function stopWorker() {
  if (wrangler.exitCode === null) {
    const exited = new Promise((resolve) => wrangler.once("exit", resolve));
    wrangler.kill();
    await Promise.race([exited, sleep(5_000)]);
  }
}

async function removeDirectory(directory) {
  for (let attempt = 0; attempt < 6; attempt += 1) {
    try { await rm(directory, { recursive: true, force: true }); return; }
    catch (error) { if (attempt === 5) throw error; await sleep(250 * (attempt + 1)); }
  }
}

function positiveInteger(value, fallback) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}
function parseConcurrency(value) {
  const parsed = [...new Set(value.split(",").map((item) => positiveInteger(item.trim(), 0)).filter(Boolean))];
  return parsed.length ? parsed : [1, 4, 16, 32];
}
function format(value) { return Number(value).toFixed(2); }
function sleep(milliseconds) { return new Promise((resolve) => setTimeout(resolve, milliseconds)); }
