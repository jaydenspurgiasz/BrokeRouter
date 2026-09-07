import assert from "node:assert/strict";

const baseUrl = process.env.BROKE_ROUTER_URL ?? "http://127.0.0.1:8797";
const headers = {
  authorization: `Bearer ${process.env.BROKE_ROUTER_API_KEY ?? "local-test-key"}`,
  "content-type": "application/json",
};

const modelsResponse = await fetch(`${baseUrl}/v1/models`, { headers });
assert.equal(modelsResponse.status, 200, "model discovery failed");
const models = (await modelsResponse.json()).data;
const hermes = models.find((model) => model.id === "free/hermes");
assert.ok(hermes, "free/hermes is missing from model discovery");
assert.equal(hermes.virtual, true);
assert.equal(hermes.contextWindow, 65_536);
assert.equal(hermes.supports.tools, true);
assert.equal(hermes.supports.streaming, true);

const messages = [{ role: "user", content: "Check the weather in Portland using the available tool, then report it." }];
const tools = [{
  type: "function",
  function: {
    name: "get_weather",
    description: "Return current weather for a city.",
    parameters: { type: "object", properties: { city: { type: "string" } }, required: ["city"] },
  },
}];

const first = await completion({ model: "free/hermes", messages, tools, max_tokens: 200 });
assert.equal(first.response.headers.get("x-broke-router-provider"), "benchmark");
assert.equal(first.body.choices[0].finish_reason, "tool_calls");
const assistant = first.body.choices[0].message;
const toolCall = assistant.tool_calls[0];
assert.equal(toolCall.function.name, "get_weather");
const { city } = JSON.parse(toolCall.function.arguments);
assert.equal(city, "Portland");

// This is the agent's local tool execution step; no model/provider is involved.
const toolOutput = `${city}: 68 F and clear`;
messages.push(assistant, { role: "tool", tool_call_id: toolCall.id, content: toolOutput });

const second = await completion({ model: "free/hermes", messages, tools, max_tokens: 200 });
assert.equal(second.response.headers.get("x-broke-router-provider"), "benchmark");
assert.equal(second.body.choices[0].finish_reason, "stop");
assert.match(second.body.choices[0].message.content, /Portland: 68 F and clear/);

console.log("PASS  free/hermes discovered with its 65,536-token tool/streaming contract");
console.log("PASS  agent requested get_weather through BrokeRouter");
console.log("PASS  local tool result returned to the agent for a final answer");
console.log("PASS  deterministic test consumed zero external provider quota");

async function completion(body) {
  const response = await fetch(`${baseUrl}/v1/chat/completions`, {
    method: "POST", headers, body: JSON.stringify(body),
  });
  const text = await response.text();
  assert.ok(response.ok, `${response.status}: ${text.slice(0, 500)}`);
  return { response, body: JSON.parse(text) };
}
