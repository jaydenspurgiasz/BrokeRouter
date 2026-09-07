import { createServer } from "node:http";

const port = Number(process.env.MOCK_PROVIDER_PORT ?? 8899);
const server = createServer(async (request, response) => {
  if (request.method !== "POST") { response.writeHead(404).end(); return; }
  const chunks = []; for await (const chunk of request) chunks.push(chunk);
  const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  const provider = request.headers.authorization === "Bearer local-a" ? "alpha" : "beta";
  if (body.stream) {
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.write(`data: ${JSON.stringify({ choices: [{ delta: { content: "STREAM_OK" } }] })}\n\n`);
    response.end("data: [DONE]\n\n"); return;
  }
  const text = JSON.stringify(body.messages);
  const marker = text.match(/QUARTZ-[A-Z0-9]+/)?.[0];
  const content = marker ?? `OK_${provider.toUpperCase()}`;
  response.writeHead(200, { "content-type": "application/json" });
  response.end(JSON.stringify({
    id: `mock-${provider}`, object: "chat.completion",
    choices: [{ index: 0, message: { role: "assistant", content, reasoning_content: "must be removed" }, finish_reason: "stop" }],
    usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 },
  }));
});
server.listen(port, "127.0.0.1", () => console.log(`mock provider ${port}`));
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => server.close(() => process.exit(0)));
