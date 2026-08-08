# Internal access model

BrokeRouter is an internal Worker, not a public API. `workers_dev` is disabled in `wrangler.jsonc`; deploy it with no public route or custom domain. Cloudflare Service Bindings are the primary authorization boundary: only your own Workers that explicitly declare a binding can invoke it.

Every caller must also include the `ROUTER_API_KEY` bearer token. Store the same secret in BrokeRouter and each authorized agent Worker with `wrangler secret put`; do not commit it or put it in a Worker variable. BrokeRouter uses constant-time comparison for this value. The Service Binding prevents Internet access; the bearer key prevents an accidental route or overly broad internal binding from becoming an unprotected gateway.

## Agent Worker binding

Add this to the **agent Worker's** Wrangler configuration, not BrokeRouter's:

```json
{
  "services": [
    { "binding": "LLM_GATEWAY", "service": "broke-router" }
  ]
}
```

Then invoke the gateway internally:

```ts
const response = await env.LLM_GATEWAY.fetch("https://broke-router/v1/chat/completions", {
  method: "POST",
  headers: {
    "content-type": "application/json",
    "authorization": `Bearer ${env.ROUTER_API_KEY}`,
  },
  body: JSON.stringify(request),
});
```

Use a distinct `ROUTER_API_KEY` for staging and production. Rotate it by updating the secret in BrokeRouter and every authorized agent Worker together. If you later need to give separate agents independently revocable credentials, add key IDs plus hashed per-agent keys; do not expose the gateway publicly just to solve that problem.
