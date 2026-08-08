import assert from "node:assert/strict";

const baseUrl = process.env.BROKE_ROUTER_URL ?? "http://localhost:8787";
const apiKey = process.env.BROKE_ROUTER_API_KEY ?? "local-test-key";
const headers = { authorization: `Bearer ${apiKey}`, "content-type": "application/json" };
const failures = [];

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
  const response = await fetch(`${baseUrl}/v1/models`);
  assert.equal(response.status, 200);
  models = (await response.json()).data;
  assert.ok(models.some((model) => model.provider === "nvidia"), "NVIDIA missing from /v1/models");
  assert.ok(models.some((model) => model.provider === "gemini"), "Gemini missing: check .dev.vars and restart dev server");
});

await check("forced NVIDIA route", async () => {
  const { response, json } = await call("/v1/chat/completions", {
    model: "nvidia/openai/gpt-oss-20b", messages: [{ role: "user", content: "Reply with exactly OK." }], max_tokens: 80,
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

await check("durable async job", async () => {
  const { json: queued } = await call("/v1/jobs", {
    model: "nvidia/openai/gpt-oss-20b", messages: [{ role: "user", content: "Reply with exactly ASYNC OK." }], max_tokens: 80,
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

if (failures.length) {
  console.error(`\n${failures.length} integration check(s) failed.`);
  process.exitCode = 1;
} else {
  console.log("\nAll BrokeRouter integration checks passed.");
}
