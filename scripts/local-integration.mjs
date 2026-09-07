import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

await run(process.execPath, ["scripts/build-local.mjs"]);
const directory = await mkdtemp(join(tmpdir(), "brokerouter-node-"));
const routerPort = 8878; const upstreamPort = 8879; const routerKey = "local-router-key-with-at-least-32-characters";
const model = (id) => ({ id: "free/default", upstreamModel: id, contextWindow: 131072, maxOutputTokens: 8192,
  supports: { streaming: true, tools: true, structuredOutput: false, vision: false }, tier: "balanced", free: true });
const environment = {
  ...process.env,
  BROKEROUTER_PORT: String(routerPort),
  BROKEROUTER_DATABASE_PATH: join(directory, "router.sqlite"),
  ROUTER_API_KEY: routerKey,
  NVIDIA_ENABLED: "false",
  BROKEROUTER_PROVIDER_ACCOUNT_MOCK_ALPHA: JSON.stringify({ provider: "mock", credentialScope: "alpha",
    endpoint: `http://127.0.0.1:${upstreamPort}/v1/chat/completions`, apiKey: "local-a", models: [model("mock-alpha")],
    rateLimits: { dailySafetyBudgetTokens: 0, cooldownMs: 5000, requests: { limit: 1, windowMs: 60000 }, maxConcurrent: 1, reservationTtlMs: 30000 } }),
  BROKEROUTER_PROVIDER_ACCOUNT_MOCK_BETA: JSON.stringify({ provider: "mock", credentialScope: "beta",
    endpoint: `http://127.0.0.1:${upstreamPort}/v1/chat/completions`, apiKey: "local-b", models: [model("mock-beta")],
    rateLimits: { dailySafetyBudgetTokens: 0, cooldownMs: 5000, requests: { limit: 10, windowMs: 60000 }, maxConcurrent: 1, reservationTtlMs: 30000 } }),
};
const upstream = child("scripts/mock-openai-provider.mjs", { ...process.env, MOCK_PROVIDER_PORT: String(upstreamPort) });
let router;
try {
  await waitFor(`http://127.0.0.1:${upstreamPort}`, upstream, false);
  router = child("dist/adapters/node/server.js", environment);
  await waitFor(base("/health"), router, true);
  const health = await fetch(base("/health")).then((response) => response.json());
  assert.equal(health.runtime, "node-sqlite");
  const models = await request("/v1/models");
  assert.ok(models.data.some((entry) => entry.id === "free/hermes"));
  assert.ok(models.data.some((entry) => entry.id === "free/compression"));

  const first = await completion({ model: "free/hermes", route: { affinityKey: "conversation-1" },
    messages: [{ role: "user", content: "Remember QUARTZ-LOCAL42." }], max_tokens: 64 });
  assert.equal(first.headers.get("x-broke-router-provider"), "mock");
  assert.equal(first.headers.get("x-broke-router-model"), "mock@alpha/free/default");
  assert.equal(first.body.choices[0].message.reasoning_content, undefined);
  const second = await completion({ model: "free/hermes", route: { affinityKey: "conversation-1" },
    messages: [{ role: "user", content: "Remember QUARTZ-LOCAL42." }, first.body.choices[0].message,
      { role: "user", content: "What marker was provided?" }], max_tokens: 64 });
  assert.match(second.body.choices[0].message.content, /QUARTZ-LOCAL42/);
  assert.equal(second.headers.get("x-broke-router-model"), "mock@beta/free/default");

  const stream = await fetch(base("/v1/chat/completions"), { method: "POST", headers: auth(), body: JSON.stringify({
    model: "mock@beta/free/default", stream: true, messages: [{ role: "user", content: "stream" }], max_tokens: 32,
  }) });
  assert.equal(stream.status, 200); assert.match(await stream.text(), /STREAM_OK[\s\S]*\[DONE\]/);

  await stop(router); router = undefined;
  router = child("dist/adapters/node/server.js", environment);
  await waitFor(base("/health"), router, true);
  const afterRestart = await completion({ model: "free/hermes", messages: [{ role: "user", content: "restart" }], max_tokens: 64 });
  assert.equal(afterRestart.headers.get("x-broke-router-model"), "mock@beta/free/default",
    "alpha quota must remain exhausted after restart");
  console.log("PASS native server, SQLite restart persistence, multi-account fallback, affinity failover, context, and SSE");
} finally {
  if (router) await stop(router); await stop(upstream); await removeDirectory(directory);
}

function base(path) { return `http://127.0.0.1:${routerPort}${path}`; }
function auth() { return { authorization: `Bearer ${routerKey}`, "content-type": "application/json" }; }
async function request(path) { const response = await fetch(base(path), { headers: auth() }); assert.equal(response.status, 200); return response.json(); }
async function completion(body) {
  const response = await fetch(base("/v1/chat/completions"), { method: "POST", headers: auth(), body: JSON.stringify(body) });
  const text = await response.text(); assert.equal(response.status, 200, text); return { headers: response.headers, body: JSON.parse(text) };
}
function child(script, env) { return spawn(process.execPath, [script], { env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true }); }
async function waitFor(url, process, requireOk) {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    if (process.exitCode !== null) throw new Error(`process exited ${process.exitCode}`);
    try { const response = await fetch(url); if (!requireOk || response.ok) return; } catch {}
    await delay(100);
  } throw new Error(`process did not become ready: ${url}`);
}
async function stop(childProcess) {
  if (childProcess.exitCode !== null) return;
  let exited = false;
  const exitPromise = new Promise((resolve) => childProcess.once("exit", () => { exited = true; resolve(); }));
  childProcess.kill("SIGTERM");
  await Promise.race([exitPromise, delay(3000)]);
  if (!exited && process.platform === "win32" && childProcess.pid) {
    const killer = spawn("taskkill.exe", ["/pid", String(childProcess.pid), "/t", "/f"], { stdio: "ignore", windowsHide: true });
    await new Promise((resolve) => killer.once("exit", resolve));
    await Promise.race([exitPromise, delay(3000)]);
  }
  childProcess.stdout?.destroy(); childProcess.stderr?.destroy(); childProcess.unref();
}
async function removeDirectory(path) {
  let error;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try { await rm(path, { recursive: true, force: true }); return; }
    catch (caught) { error = caught; await delay(100 * (attempt + 1)); }
  }
  if (error?.code === "EBUSY" && process.platform === "win32") {
    console.warn(`WARN Windows retained a temporary SQLite lock; OS cleanup will reclaim ${path}`);
    return;
  }
  throw error;
}
function run(command, args) { return new Promise((resolve, reject) => { const process = spawn(command, args, { stdio: "inherit", windowsHide: true }); process.once("error", reject); process.once("exit", (code) => code === 0 ? resolve() : reject(new Error(`command exited ${code}`))); }); }
function delay(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }
