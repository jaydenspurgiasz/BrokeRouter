import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";

const rateFallback = process.argv.includes("--rate-fallback");
const callerLimit = process.argv.includes("--caller-limit");
const liveBenchmark = process.argv.includes("--live-benchmark");
const port = rateFallback ? 8791 : callerLimit ? 8793 : liveBenchmark ? 8795 : 8792;
const baseUrl = `http://127.0.0.1:${port}`;
const stateDir = await mkdtemp(join(tmpdir(), "broke-router-integration-"));
const argumentsList = [
  "node_modules/wrangler/bin/wrangler.js", "dev", ...(liveBenchmark ? ["--env", "staging"] : []),
  "--local", "--port", String(port),
  "--persist-to", stateDir, "--show-interactive-dev-session=false",
];
if (liveBenchmark) argumentsList.push(
  "--var", "NVIDIA_ENABLED:false",
  "--var", "ROUTER_API_KEY:local-test-key",
);
if (rateFallback) argumentsList.push(
  "--var", "NVIDIA_REQUESTS_PER_WINDOW:1",
  "--var", "NVIDIA_REQUEST_WINDOW_MS:60000",
  "--var", "MAX_INLINE_WAIT_MS:0",
);
const callerSecret = "caller-limit-integration-secret-that-is-not-production";
if (callerLimit) {
  const keyHash = createHash("sha256").update(callerSecret).digest("hex");
  const registry = JSON.stringify({
    "rate-client": {
      keyHash, environment: "evaluation",
      scopes: ["models:read", "chat:write", "stats:read", "policy:write"],
      limits: { requests: { limit: 1, windowMs: 60_000 }, reservationTtlMs: 120_000 },
    },
  });
  argumentsList.push("--var", `CALLER_CREDENTIALS_JSON:${registry}`);
}
const wrangler = spawn(process.execPath, argumentsList, {
  cwd: process.cwd(), stdio: ["ignore", "pipe", "pipe"], windowsHide: true,
});

let workerOutput = "";
wrangler.stdout.on("data", (chunk) => { workerOutput += chunk; });
wrangler.stderr.on("data", (chunk) => { workerOutput += chunk; });

try {
  await waitForHealth();
  const result = await runSmokeTest();
  process.exitCode = result;
} finally {
  await stopWorker();
  await removeState();
}

async function waitForHealth() {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${baseUrl}/health`);
      if (response.ok) return;
    } catch { /* Worker is still starting. */ }
    await sleep(250);
  }
  throw new Error(`Isolated Worker did not start within 30 seconds.\n${workerOutput.slice(-2000)}`);
}

function runSmokeTest() {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [liveBenchmark ? "scripts/benchmark-live.mjs" : "scripts/integration-smoke.mjs"], {
      cwd: process.cwd(), stdio: "inherit",
      env: {
        ...process.env,
        BROKE_ROUTER_URL: baseUrl,
        ...(liveBenchmark ? {
          BROKE_ROUTER_API_KEY: "local-test-key",
          BROKE_LIVE_REQUESTS: "5",
          BROKE_LIVE_REPEATS: "1",
          BROKE_LIVE_CONCURRENCY: "1,2",
          BROKE_LIVE_REAL_REQUESTS: "0",
        } : {}),
        BROKE_ROUTER_EXPECT_RATE_FALLBACK: rateFallback ? "1" : "0",
        BROKE_ROUTER_EXPECT_CALLER_LIMIT: callerLimit ? "1" : "0",
        ...(callerLimit ? { BROKE_ROUTER_API_KEY: `brk_rate-client.${callerSecret}` } : {}),
      },
      windowsHide: true,
    });
    child.on("error", reject);
    child.on("exit", (code) => resolve(code ?? 1));
  });
}

function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

async function stopWorker() {
  if (wrangler.exitCode === null) {
    const exited = new Promise((resolve) => wrangler.once("exit", resolve));
    wrangler.kill();
    await Promise.race([exited, sleep(5_000)]);
  }
}

async function removeState() {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      await rm(stateDir, { recursive: true, force: true });
      return;
    } catch (error) {
      if (attempt === 4) throw error;
      await sleep(250 * (attempt + 1));
    }
  }
}
