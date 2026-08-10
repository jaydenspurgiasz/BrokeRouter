import assert from "node:assert/strict";

const baseUrl = process.env.BROKE_ROUTER_URL ?? "http://localhost:8787";
const apiKey = process.env.BROKE_ROUTER_API_KEY ?? "local-test-key";
const headers = { authorization: `Bearer ${apiKey}`, "content-type": "application/json" };
const failures = [];
const rateFallbackMode = process.env.BROKE_ROUTER_EXPECT_RATE_FALLBACK === "1";
const callerLimitMode = process.env.BROKE_ROUTER_EXPECT_CALLER_LIMIT === "1";

async function check(name, run) {
  try {
    await run();
    console.log(`PASS  ${name}`);
  } catch (error) {
    failures.push({ name, error });
    console.error(`FAIL  ${name}: ${error.message}`);
  }
}

async function call(path, body) {
  const response = await fetch(`${baseUrl}${path}`, { method: "POST", headers, body: JSON.stringify(body) });
  const text = await response.text();
  let json;
  try { json = JSON.parse(text); } catch { json = undefined; }
  assert.ok(response.ok, `${response.status}: ${text.slice(0, 500)}`);
  return { response, json, text };
}

await check("health endpoint", async () => {
  const response = await fetch(`${baseUrl}/health`);
  assert.equal(response.status, 200);
  assert.equal((await response.json()).ok, true);
});

let models;
await check("active provider catalog", async () => {
  const response = await fetch(`${baseUrl}/v1/models`, { headers: { authorization: headers.authorization } });
  assert.equal(response.status, 200);
  models = (await response.json()).data;
  assert.ok(models.some((model) => model.provider === "nvidia"), "NVIDIA missing from /v1/models");
  assert.ok(models.some((model) => model.provider === "gemini"), "Gemini missing: check .dev.vars and restart dev server");
});

if (!rateFallbackMode) await check("instant policy control and rollback", async () => {
  const initial = await fetch(`${baseUrl}/v1/routing/policy`, { headers: { authorization: headers.authorization } });
  assert.equal(initial.status, 200);
  assert.match((await initial.json()).mode, /baseline|shadow|adaptive/);
  const changed = await fetch(`${baseUrl}/v1/routing/policy`, {
    method: "PUT", headers,
    body: JSON.stringify({ mode: "baseline", explorationRate: 0, minObservations: 30 }),
  });
  assert.equal(changed.status, 200);
  assert.equal((await changed.json()).mode, "baseline");
  const restored = await fetch(`${baseUrl}/v1/routing/policy`, {
    method: "PUT", headers,
    body: JSON.stringify({ mode: "shadow", explorationRate: 0.05, minObservations: 30 }),
  });
  assert.equal(restored.status, 200);
  assert.equal((await restored.json()).mode, "shadow");
});

if (rateFallbackMode) {
  await check("automatic NVIDIA rate-limit fallback to Gemini", async () => {
    const request = {
      model: "free/default", messages: [{ role: "user", content: "Reply with exactly OK." }], max_tokens: 80,
    };
    const first = await call("/v1/chat/completions", request);
    assert.equal(first.response.headers.get("x-broke-router-provider"), "nvidia", "First free/default call must use NVIDIA");
    const second = await call("/v1/chat/completions", request);
    assert.equal(second.response.headers.get("x-broke-router-provider"), "gemini", "Second free/default call must automatically fall back to Gemini");
  });
} else if (callerLimitMode) {
  await check("caller-scoped admission gate", async () => {
    const request = {
      model: "free/default", messages: [{ role: "user", content: "Reply with exactly OK." }], max_tokens: 80,
    };
    await call("/v1/chat/completions", request);
    const blocked = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: "POST", headers, body: JSON.stringify(request),
    });
    assert.equal(blocked.status, 429);
    const error = await blocked.json();
    assert.equal(error.error?.code, "caller_rate_limited");
  });
} else {

await check("forced NVIDIA route", async () => {
  const { response, json } = await call("/v1/chat/completions", {
    model: "nvidia/openai/gpt-oss-20b", messages: [{ role: "user", content: "Reply with exactly OK." }], max_tokens: 200,
  });
  assert.equal(response.headers.get("x-broke-router-provider"), "nvidia");
  assert.ok(json.choices?.[0]?.message?.content, "NVIDIA returned no visible content");
});

await check("forced Gemini route", async () => {
  const gemini = models.find((model) => model.provider === "gemini");
  assert.ok(gemini?.id, "No explicit Gemini model ID");
  const { response, json } = await call("/v1/chat/completions", {
    model: gemini.id, messages: [{ role: "user", content: "Reply with exactly OK." }], max_tokens: 80,
  });
  assert.equal(response.headers.get("x-broke-router-provider"), "gemini");
  assert.ok(json.choices?.[0]?.message?.content, "Gemini returned no visible content");
});

await check("NVIDIA reasoning is not leaked", async () => {
  const { json } = await call("/v1/chat/completions", {
    model: "nvidia/openai/gpt-oss-20b", route: { reasoning: "on" },
    messages: [{ role: "user", content: "What is 17 times 19? Answer only." }], max_tokens: 300,
  });
  const message = json.choices?.[0]?.message ?? {};
  assert.equal(message.reasoning, undefined);
  assert.equal(message.reasoning_content, undefined);
  assert.ok(message.content, "No final answer after reasoning");
});

await check("SSE streaming", async () => {
  const response = await fetch(`${baseUrl}/v1/chat/completions`, {
    method: "POST", headers,
    body: JSON.stringify({ model: "nvidia/openai/gpt-oss-20b", stream: true, messages: [{ role: "user", content: "Say hello." }], max_tokens: 80 }),
  });
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /text\/event-stream/);
  const text = await response.text();
  assert.match(text, /data:/, "Expected SSE data frames");
});

await check("durable workflow lifecycle and learned statistics", async () => {
  const { json: workflow } = await call("/v1/workflows", {
    workflowType: "coding-agent",
    expectedCalls: 2,
    maxCalls: 4,
    maxConcurrency: 1,
    estimatedTotalTokens: 4_000,
    qualityTier: "balanced",
    priority: 75,
  });
  assert.ok(workflow.id, "Workflow was not created");
  const completion = await call("/v1/chat/completions", {
    model: "free/default",
    route: { workflowId: workflow.id, expectedCalls: 999, preferredProviderId: "spoofed" },
    messages: [{ role: "user", content: "Reply with exactly WORKFLOW OK." }],
    max_tokens: 80,
  });
  assert.ok(completion.response.headers.get("x-broke-router-policy"));

  const accountingDeadline = Date.now() + 10_000;
  let current;
  while (Date.now() < accountingDeadline) {
    const response = await fetch(`${baseUrl}/v1/workflows/${workflow.id}`, { headers: { authorization: headers.authorization } });
    assert.equal(response.status, 200);
    current = await response.json();
    if (current.callsCompleted >= 1 && current.inFlight === 0) break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.equal(current?.callsCompleted, 1, "Workflow call accounting was not finalized");
  assert.ok(current?.primaryProvider, "Workflow provider affinity was not recorded");

  const outcome = await call(`/v1/workflows/${workflow.id}/outcome`, {
    success: true, quality: 0.95, validatorPassed: true, deadlineMet: true,
  });
  assert.equal(outcome.json.status, "completed");

  const statsDeadline = Date.now() + 10_000;
  let learned = false;
  while (Date.now() < statsDeadline) {
    const response = await fetch(`${baseUrl}/v1/routing/stats`, { headers: { authorization: headers.authorization } });
    assert.equal(response.status, 200);
    const stats = await response.json();
    if (stats.decisions >= 1 && stats.outcomes >= 1 && stats.workflows >= 1) {
      assert.ok(stats.providers.length >= 1, "No online provider statistics were learned");
      learned = true;
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  if (!learned) throw new Error("Routing statistics were not reconciled within 10 seconds");
  const evaluationResponse = await fetch(`${baseUrl}/v1/routing/evaluation`, { headers: { authorization: headers.authorization } });
  assert.equal(evaluationResponse.status, 200);
  const evaluation = await evaluationResponse.json();
  assert.equal(evaluation.metric, "call_success_proxy");
  assert.ok(typeof evaluation.effectiveSampleSize === "number");
  const { json: forecasted } = await call("/v1/workflows", {
    workflowType: "coding-agent", maxConcurrency: 1, qualityTier: "balanced",
  });
  assert.ok(forecasted.planningForecast.observations >= 1, "Workflow forecast did not learn from the outcome");
  assert.ok(forecasted.expectedCalls >= 1 && forecasted.estimatedTotalTokens >= 1);
});

await check("durable workflow deadline alarm", async () => {
  const { json: workflow } = await call("/v1/workflows", {
    workflowType: "batch", expectedCalls: 1, maxCalls: 1, maxConcurrency: 1,
    estimatedTotalTokens: 1_000, deadlineMs: 100, qualityTier: "economy",
  });
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const response = await fetch(`${baseUrl}/v1/workflows/${workflow.id}`, { headers: { authorization: headers.authorization } });
    assert.equal(response.status, 200);
    const current = await response.json();
    if (current.status === "failed") {
      assert.equal(current.success, false);
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("Workflow deadline alarm did not fire within 10 seconds");
});

await check("durable async job", async () => {
  const { json: queued } = await call("/v1/jobs", {
    model: "nvidia/openai/gpt-oss-20b", messages: [{ role: "user", content: "Reply with exactly ASYNC OK." }], max_tokens: 200,
  });
  assert.equal(queued.status, "queued");
  assert.ok(queued.id);
  const deadline = Date.now() + 45_000;
  while (Date.now() < deadline) {
    const response = await fetch(`${baseUrl}/v1/jobs/${queued.id}`, { headers: { authorization: headers.authorization } });
    assert.equal(response.status, 200);
    const job = await response.json();
    if (job.status === "completed") { assert.ok(job.result?.choices?.[0]?.message?.content); return; }
    if (job.status === "failed") throw new Error(job.error ?? "Job failed");
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error("Job did not complete within 45 seconds");
});
}

if (failures.length) {
  console.error(`\n${failures.length} integration check(s) failed.`);
  process.exitCode = 1;
} else {
  console.log("\nAll BrokeRouter integration checks passed.");
}
