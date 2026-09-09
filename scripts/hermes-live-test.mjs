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
// Never change account limits upward for a real-token test: the provider's actual quota
// is authoritative and the router must be tested against the limits it was configured to honor.
const port = 20_000 + Math.floor(Math.random() * 20_000);
await runLocalSuite("behavior", port, sourceEnv, runBehaviorSuite);
console.log("\nAll bounded live Hermes checks passed using the configured NVIDIA and Gemini limits.");

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
  // Keep this bounded suite within the configured Gemini 5 RPM allowance. The automatic
  // Hermes context route consumes the tighter Gemini account; exercise tools on NVIDIA.
  await checkToolWorkflow(baseUrl, nvidiaModel.id);
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
      signal: AbortSignal.timeout(75_000),
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
  const affinityKey = `context-${randomBytes(8).toString("hex")}`;
  const messages = [{
    role: "user",
    content: `The temporary project codename for this conversation is ${marker}. Acknowledge the codename.`,
  }];
  const first = await completion(baseUrl, {
    model: "free/hermes", route: { affinityKey }, messages,
    reasoning_effort: "low", max_tokens: 512,
  });
  const assistant = first.body.choices?.[0]?.message;
  assert.ok(assistant?.content, "first context turn returned no content");
  messages.push(assistant, {
    role: "user", content: "What temporary project codename did I give you? Return only that codename.",
  });
  const second = await completion(baseUrl, {
    model: "free/hermes", route: { affinityKey }, messages,
    reasoning_effort: "low", max_tokens: 512,
  });
  assert.match(second.body.choices?.[0]?.message?.content ?? "", new RegExp(marker));
  const firstProvider = first.response.headers.get("x-broke-router-provider");
  const secondProvider = second.response.headers.get("x-broke-router-provider");
  pass("multi-turn context + sticky failover", `providers=${firstProvider}->${secondProvider}, calls=2`);
}

async function checkToolWorkflow(baseUrl, model) {
  const affinityKey = `tool-${randomBytes(8).toString("hex")}`;
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
    model, route: { affinityKey }, messages, tools, tool_choice: "required",
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
    model, route: { affinityKey }, messages, tools, tool_choice: "none",
    reasoning_effort: "low", max_tokens: 512,
  });
  assert.match(second.body.choices?.[0]?.message?.content ?? "", new RegExp(toolMarker));
  pass("real agentic tool loop", `provider=${second.response.headers.get("x-broke-router-provider")}, calls=2`);
}

async function runLocalSuite(name, port, values, suite) {
  const runDir = await mkdtemp(join(tmpdir(), `brokerouter-live-${name}-`));
  const envPath = join(runDir, ".env.live");
  const statePath = join(runDir, "brokerouter.sqlite");
  const environment = {
    ...values,
    NVIDIA_ENABLED: "false",
    BENCHMARK_PROVIDER_ENABLED: "false",
    AGENT_TEST_PROVIDER_ENABLED: "false",
    ROUTING_POLICY_MODE: "baseline",
    MAX_INLINE_WAIT_MS: "0",
    BROKEROUTER_PORT: String(port),
    BROKEROUTER_DATABASE_PATH: statePath,
    BROKEROUTER_ENV_FILE: join(runDir, "missing.env"),
  };
  await writeFile(envPath, serializeDotEnv(environment), { encoding: "utf8", mode: 0o600 });
  const child = spawn(process.execPath, ["dist/adapters/node/server.js"], {
    cwd: process.cwd(), env: environment, stdio: ["ignore", "pipe", "pipe"], windowsHide: true,
  });
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

async function completion(baseUrl, body, retries = 0) {
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

async function waitForHealth(baseUrl, child, readOutput) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`Node server exited early (${child.exitCode})`);
    try {
      const response = await fetch(`${baseUrl}/health`);
      if (response.ok) return;
    } catch { /* startup */ }
    await delay(250);
  }
  throw new Error(`Node server did not start: ${redact(readOutput().slice(-2_000))}`);
}

async function stop(child) {
  if (child.exitCode !== null) return;
  let didExit = false;
  const exited = new Promise((resolveExit) => child.once("exit", () => { didExit = true; resolveExit(); }));
  child.kill("SIGTERM");
  await Promise.race([exited, delay(3_000)]);
  if (!didExit && process.platform === "win32" && child.pid) {
    const killer = spawn("taskkill.exe", ["/pid", String(child.pid), "/t", "/f"], {
      stdio: "ignore", windowsHide: true,
    });
    await new Promise((resolveKill) => killer.once("exit", resolveKill));
    await Promise.race([exited, delay(3_000)]);
  }
  child.stdout?.destroy(); child.stderr?.destroy(); child.unref();
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
