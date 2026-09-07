import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { randomBytes } from "node:crypto";

const sourceEnvPath = resolve(process.env.BROKE_ROUTER_ENV_FILE ?? ".env");
const sourceEnv = parseDotEnv(await readFile(sourceEnvPath, "utf8"));
const nvidiaName = "BROKEROUTER_PROVIDER_ACCOUNT_NVIDIA_PRIMARY";
const geminiName = "BROKEROUTER_PROVIDER_ACCOUNT_GEMINI_PRIMARY";
const nvidia = parseAccount(sourceEnv[nvidiaName], nvidiaName, "nvidia");
const gemini = parseAccount(sourceEnv[geminiName], geminiName, "gemini");
const routerKey = sourceEnv.ROUTER_API_KEY;
assert.ok(routerKey?.length >= 32, "ROUTER_API_KEY must contain at least 32 characters");
const secretValues = [routerKey, nvidia.apiKey, gemini.apiKey];

const behaviorEnv = {
  ...sourceEnv,
  // Make NVIDIA the tighter safe bin for the two-call Hermes context workflow. This verifies
  // best-fit selection deterministically without changing the user's persisted account limits.
  [nvidiaName]: JSON.stringify(withRequestLimit(nvidia, 4, 60_000)),
  [geminiName]: JSON.stringify(withRequestLimit(gemini, 100, 60_000)),
};
await runWorkerSuite("behavior", 8801, behaviorEnv, runBehaviorSuite);

const rateEnv = {
  ...sourceEnv,
  [nvidiaName]: JSON.stringify(withRequestLimit(nvidia, 1, 60_000)),
  [geminiName]: JSON.stringify(withRequestLimit(gemini, 10, 60_000)),
};
await runWorkerSuite("rate-fallback", 8802, rateEnv, runRateFallbackSuite);

console.log("\nAll live Hermes checks passed using real NVIDIA and Gemini calls.");

async function runBehaviorSuite(baseUrl) {
  const headers = authHeaders();
  const modelsResponse = await fetch(`${baseUrl}/v1/models`, { headers });
  assert.equal(modelsResponse.status, 200, "model discovery failed");
  const models = (await modelsResponse.json()).data;
  const hermes = models.find((model) => model.id === "free/hermes");
  assert.ok(hermes?.virtual, "free/hermes virtual model is missing");
  const nvidiaModel = models.find((model) => model.provider === "nvidia" && model.credentialScope === "primary");
  const geminiModel = models.find((model) => model.provider === "gemini" && model.credentialScope === "primary");
  assert.ok(nvidiaModel?.id && geminiModel?.id, "scoped NVIDIA/Gemini models are missing");
  pass("provider discovery", "free/hermes + nvidia/primary + gemini/primary");

  await checkProvider(baseUrl, nvidiaModel.id, "nvidia");
  await checkProvider(baseUrl, geminiModel.id, "gemini");
  await checkStreaming(baseUrl, geminiModel.id);
  await checkContextWorkflow(baseUrl);
  await checkToolWorkflow(baseUrl, geminiModel.id);
}

async function checkProvider(baseUrl, model, expectedProvider) {
  const started = Date.now();
  const result = await completion(baseUrl, {
    model, messages: [{ role: "user", content: "Reply with exactly LIVE_OK." }],
    max_tokens: expectedProvider === "gemini" ? 512 : 80,
    ...(expectedProvider === "gemini" ? { reasoning_effort: "low" } : {}),
  });
  assert.equal(result.response.headers.get("x-broke-router-provider"), expectedProvider);
  assert.ok(result.body.choices?.[0]?.message?.content, `${expectedProvider} returned no content`);
  pass(`${expectedProvider} live completion`, `${Date.now() - started}ms`);
}

async function checkStreaming(baseUrl, model) {
  for (let attempt = 0; ; attempt += 1) {
    const response = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: "POST", headers: authHeaders(),
      body: JSON.stringify({
        model, stream: true, reasoning_effort: "low",
        messages: [{ role: "user", content: "Reply with exactly STREAM_OK." }], max_tokens: 512,
      }),
    });
    const text = await response.text();
    if (response.ok) {
      assert.match(response.headers.get("content-type") ?? "", /text\/event-stream/);
      assert.match(text, /data:/);
      assert.match(text, /\[DONE\]/);
      pass("Gemini streaming passthrough", `${text.length} response bytes`);
      return;
    }
    const retryable = response.status === 429 || response.status >= 500;
    if (!retryable || attempt >= 3) assert.fail(safeHttpError(response, text));
    const retryAfter = Number(response.headers.get("retry-after"));
    const waitMs = Number.isFinite(retryAfter) && retryAfter > 0
      ? Math.min(10_000, retryAfter * 1_000) : 5_500;
    console.log(`RETRY streaming completion after ${response.status} (${waitMs}ms, attempt ${attempt + 1}/3)`);
    await delay(waitMs);
  }
}

async function checkContextWorkflow(baseUrl) {
  const marker = `QUARTZ-${randomBytes(5).toString("hex").toUpperCase()}`;
  const workflow = await post(baseUrl, "/v1/workflows", {
    workflowType: "coding-agent", expectedCalls: 2, maxCalls: 6, maxConcurrency: 1,
    estimatedTotalTokens: 2_000, qualityTier: "balanced",
  });
  assert.ok(workflow.body.id, "workflow was not created");
  const messages = [{
    role: "user",
    content: `The temporary project codename for this conversation is ${marker}. Acknowledge the codename.`,
  }];
  const first = await completion(baseUrl, {
    model: "free/hermes", route: { workflowId: workflow.body.id }, messages,
    reasoning_effort: "low", max_tokens: 512,
  });
  const assistant = first.body.choices?.[0]?.message;
  assert.ok(assistant?.content, "first context turn returned no content");
  messages.push(assistant, {
    role: "user", content: "What temporary project codename did I give you? Return only that codename.",
  });
  const second = await completion(baseUrl, {
    model: "free/hermes", route: { workflowId: workflow.body.id }, messages,
    reasoning_effort: "low", max_tokens: 512,
  });
  assert.match(second.body.choices?.[0]?.message?.content ?? "", new RegExp(marker));
  assert.equal(
    second.response.headers.get("x-broke-router-provider"),
    first.response.headers.get("x-broke-router-provider"),
    "workflow affinity changed provider between context turns",
  );
  const state = await waitForWorkflow(baseUrl, workflow.body.id, 2);
  assert.equal(state.callsCompleted, 2);
  pass("multi-turn context + workflow affinity", `provider=${state.primaryProvider}, calls=2`);
}

async function checkToolWorkflow(baseUrl, model) {
  const workflow = await post(baseUrl, "/v1/workflows", {
    workflowType: "tool-agent", expectedCalls: 2, maxCalls: 10, maxConcurrency: 1,
    estimatedTotalTokens: 2_000, qualityTier: "balanced",
  });
  const tools = [{
    type: "function",
    function: {
      name: "lookup_inventory",
      description: "Look up the inventory status for one item.",
      parameters: {
        type: "object", properties: { item: { type: "string" } }, required: ["item"],
      },
    },
  }];
  const messages = [{
    role: "user",
    content: "Use lookup_inventory for item blue-widget. Do not guess the inventory yourself.",
  }];
  const first = await completion(baseUrl, {
    model, route: { workflowId: workflow.body.id }, messages, tools, tool_choice: "required",
    reasoning_effort: "low", max_tokens: 512,
  });
  const assistant = first.body.choices?.[0]?.message;
  const toolCall = assistant?.tool_calls?.[0];
  assert.equal(toolCall?.function?.name, "lookup_inventory", "model did not request the expected tool");
  const args = JSON.parse(toolCall.function.arguments);
  assert.match(String(args.item ?? ""), /blue-widget/i);
  const toolMarker = `IN_STOCK_${randomBytes(4).toString("hex").toUpperCase()}`;
  messages.push(assistant, { role: "tool", tool_call_id: toolCall.id, content: toolMarker });
  const second = await completion(baseUrl, {
    model, route: { workflowId: workflow.body.id }, messages, tools, tool_choice: "none",
    reasoning_effort: "low", max_tokens: 512,
  });
  assert.match(second.body.choices?.[0]?.message?.content ?? "", new RegExp(toolMarker));
  const state = await waitForWorkflow(baseUrl, workflow.body.id, 2);
  assert.ok(state.callsCompleted >= 2);
  pass("real agentic tool loop", `provider=${state.primaryProvider}, calls=${state.callsCompleted}`);
}

async function runRateFallbackSuite(baseUrl) {
  const request = {
    model: "free/hermes", messages: [{ role: "user", content: "Reply with exactly RATE_OK." }], max_tokens: 80,
  };
  const first = await completion(baseUrl, request, 0);
  const second = await completion(baseUrl, request, 3);
  assert.equal(first.response.headers.get("x-broke-router-provider"), "nvidia",
    "tightest eligible request bucket should be consumed first");
  assert.equal(second.response.headers.get("x-broke-router-provider"), "gemini",
    "exhausted NVIDIA account should fall back to Gemini");
  const statsResponse = await fetch(`${baseUrl}/v1/routing/stats`, { headers: authHeaders() });
  assert.equal(statsResponse.status, 200);
  const stats = await statsResponse.json();
  assert.ok(stats.decisions >= 2 && stats.outcomes >= 2, "rate test outcomes were not persisted");
  pass("credential-scoped predictive rate fallback", "nvidia -> gemini; persisted outcomes >= 2");
}

async function runWorkerSuite(name, port, values, suite) {
  const runDir = await mkdtemp(join(tmpdir(), `brokerouter-live-${name}-`));
  const envPath = join(runDir, ".env.live");
  const statePath = join(runDir, "state");
  const environment = {
    ...values,
    NVIDIA_ENABLED: "false",
    BENCHMARK_PROVIDER_ENABLED: "false",
    AGENT_TEST_PROVIDER_ENABLED: "false",
    ROUTING_POLICY_MODE: "baseline",
    MAX_INLINE_WAIT_MS: "0",
  };
  await writeFile(envPath, serializeDotEnv(environment), { encoding: "utf8", mode: 0o600 });
  const child = spawn(process.execPath, [
    "node_modules/wrangler/bin/wrangler.js", "dev", "--local", "--port", String(port),
    "--persist-to", statePath, "--env-file", envPath, "--show-interactive-dev-session=false",
  ], { cwd: process.cwd(), stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
  let output = "";
  child.stdout.on("data", (chunk) => { output += chunk; });
  child.stderr.on("data", (chunk) => { output += chunk; });
  let failure;
  try {
    await waitForHealth(`http://127.0.0.1:${port}`, child, () => output);
    await suite(`http://127.0.0.1:${port}`);
  } catch (error) {
    const diagnostics = redact(`${error?.stack ?? error}\n${output.slice(-4_000)}`);
    failure = new Error(`${name} suite failed:\n${diagnostics}`);
  } finally {
    await stop(child);
    try {
      await removeRunDirectory(runDir);
    } catch (cleanupError) {
      if (!failure) throw cleanupError;
      failure.message += `\nCleanup warning: ${cleanupError.message}`;
    }
  }
  if (failure) throw failure;
}

async function completion(baseUrl, body, retries = 3) {
  for (let attempt = 0; ; attempt += 1) {
    const response = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: "POST", headers: authHeaders(), body: JSON.stringify(body),
    });
    const text = await response.text();
    if (response.ok) return { response, body: JSON.parse(text) };
    const retryable = response.status === 429 || response.status >= 500;
    if (!retryable || attempt >= retries) assert.fail(safeHttpError(response, text));
    const retryAfter = Number(response.headers.get("retry-after"));
    const waitMs = Number.isFinite(retryAfter) && retryAfter > 0
      ? Math.min(10_000, retryAfter * 1_000) : 5_500;
    console.log(`RETRY chat completion after ${response.status} (${waitMs}ms, attempt ${attempt + 1}/${retries})`);
    await delay(waitMs);
  }
}

async function post(baseUrl, path, body) {
  const response = await fetch(`${baseUrl}${path}`, {
    method: "POST", headers: authHeaders(), body: JSON.stringify(body),
  });
  const text = await response.text();
  assert.ok(response.ok, safeHttpError(response, text));
  return { response, body: JSON.parse(text) };
}

async function waitForWorkflow(baseUrl, id, completedCalls) {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const response = await fetch(`${baseUrl}/v1/workflows/${id}`, { headers: authHeaders() });
    assert.equal(response.status, 200);
    const body = await response.json();
    if (body.callsCompleted >= completedCalls && body.inFlight === 0) return body;
    await delay(100);
  }
  throw new Error(`workflow ${id} did not settle`);
}

async function waitForHealth(baseUrl, child, readOutput) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`Worker exited early (${child.exitCode})`);
    try {
      const response = await fetch(`${baseUrl}/health`);
      if (response.ok) return;
    } catch { /* startup */ }
    await delay(250);
  }
  throw new Error(`Worker did not start: ${redact(readOutput().slice(-2_000))}`);
}

async function stop(child) {
  if (child.exitCode !== null) return;
  const exited = new Promise((resolveExit) => child.once("exit", resolveExit));
  if (process.platform === "win32" && child.pid) {
    const killer = spawn("taskkill.exe", ["/pid", String(child.pid), "/t", "/f"], {
      stdio: "ignore", windowsHide: true,
    });
    await new Promise((resolveKill) => killer.once("exit", resolveKill));
  } else {
    child.kill();
  }
  await Promise.race([exited, delay(5_000)]);
}

async function removeRunDirectory(runDir) {
  let lastError;
  for (let attempt = 0; attempt < 12; attempt += 1) {
    try {
      await rm(runDir, { recursive: true, force: true });
      return;
    } catch (error) {
      lastError = error;
      await delay(250 * (attempt + 1));
    }
  }
  throw lastError;
}

function parseDotEnv(source) {
  const values = {};
  for (const rawLine of source.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!match) throw new Error("Private .env contains an unsupported line (value hidden)");
    let value = match[2].trim();
    if ((value.startsWith("'") && value.endsWith("'")) || (value.startsWith('"') && value.endsWith('"'))) {
      value = value.slice(1, -1);
    }
    values[match[1]] = value;
  }
  return values;
}

function parseAccount(raw, bindingName, expectedProvider) {
  assert.ok(raw, `${bindingName} is missing`);
  let account;
  try { account = JSON.parse(raw); } catch { throw new Error(`${bindingName} is invalid JSON (value hidden)`); }
  assert.equal(account.provider, expectedProvider, `${bindingName} has the wrong provider`);
  assert.ok(account.apiKey?.length >= 20, `${bindingName} has no usable key`);
  return account;
}

function withRequestLimit(account, limit, windowMs) {
  return {
    ...account,
    rateLimits: {
      dailySafetyBudgetTokens: 0, cooldownMs: 5_000,
      requests: { limit, windowMs }, maxConcurrent: 1, reservationTtlMs: 30_000,
    },
  };
}

function serializeDotEnv(values) {
  return Object.entries(values).map(([name, value]) => {
    const text = String(value);
    if (text.includes("'")) throw new Error(`${name} cannot be safely quoted (value hidden)`);
    return `${name}='${text}'`;
  }).join("\n") + "\n";
}

function authHeaders() {
  return { authorization: `Bearer ${routerKey}`, "content-type": "application/json" };
}

function safeHttpError(response, text) {
  return `${response.status}: ${redact(text.slice(0, 1_000))}`;
}

function redact(text) {
  return secretValues.reduce((safe, secret) => safe.split(secret).join("[REDACTED]"), String(text));
}

function pass(name, detail) { console.log(`PASS  ${name} (${detail})`); }
function delay(ms) { return new Promise((resolveDelay) => setTimeout(resolveDelay, ms)); }
