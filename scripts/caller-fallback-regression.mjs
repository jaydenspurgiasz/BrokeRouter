import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { executeLocalGeneration } from "../dist/adapters/node/execution.js";
import { SqliteState } from "../dist/adapters/node/sqlite-state.js";

const directory = await mkdtemp(join(tmpdir(), "brokerouter-caller-fallback-"));
const state = new SqliteState(join(directory, "router.sqlite"));
const model = (provider) => ({ id: `${provider}/model`, provider, credentialScope: "default", upstreamModel: "model",
  contextWindow: 131072, maxOutputTokens: 8192, supports: { streaming: true, tools: true, structuredOutput: false, vision: false },
  tier: "balanced", free: true });
const limits = { dailySafetyBudgetTokens: 0, cooldownMs: 1, maxConcurrent: 1, reservationTtlMs: 30_000 };
const providers = [{ id: "alpha", credentialScope: "default", models: [model("alpha")], rateLimits: limits,
  invoke: async () => new Response("temporarily unavailable", { status: 503 }) }, {
  id: "beta", credentialScope: "default", models: [model("beta")], rateLimits: limits,
  invoke: async () => Response.json({ choices: [{ message: { role: "assistant", content: "ok" } }], usage: { total_tokens: 4 } }),
}];
const identity = { callerId: "hermes", environment: "production", rateLimits: { ...limits, requests: { limit: 1, windowMs: 60_000 } } };
const request = { model: "free/hermes", messages: [{ role: "user", content: "test fallback" }], max_tokens: 4 };
try {
  const response = await executeLocalGeneration(request, providers, state, identity, "a-long-test-affinity-secret-at-least-32");
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("x-broke-router-provider"), "beta");
  await assert.rejects(
    () => executeLocalGeneration(request, providers, state, identity, "a-long-test-affinity-secret-at-least-32"),
    (error) => error?.code === "caller_rate_limited",
  );
  console.log("PASS caller quota is charged once across provider fallback");
} finally {
  state.close();
  await rm(directory, { recursive: true, force: true }).catch(() => undefined);
}
