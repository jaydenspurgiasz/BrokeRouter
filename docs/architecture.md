# Architecture

```text
Agent Worker --Service Binding--> Gateway Worker --HTTPS--> Provider API
                                      |
                                      +--RPC--> credential-scoped Quota Coordinator
```

The public HTTP surface and the Service-Binding surface use the same handler. `ROUTER_API_KEY` is optional because a Service Binding is already private; set it when exposing a public gateway endpoint.

For each request the gateway validates the request, filters models by non-negotiable capabilities and context fit, then asks each provider credential coordinator to admit it. Admission accounts for predictive request/token buckets, concurrent reservations, daily budget, and cooldowns. It calls the first available provider; if none can admit, it waits only for a small configured interactive queue window and otherwise returns `503` with `Retry-After`. Success and failure reconciliation is scheduled with `waitUntil`, so it does not delay bytes flowing from an SSE response. A provider failure or 429 marks the provider credential as cooling down. OpenAI-compatible providers are configured as registry entries with their own credential scope and limits; they cannot receive a request they cannot faithfully represent.
