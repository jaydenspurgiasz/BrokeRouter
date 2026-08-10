# Architecture

```text
Cloudflare Agent --Service Binding---> Gateway Worker --HTTPS--> Provider API
Local Agent --Cloudflare Access------>       |
                                               +--RPC--> credential-scoped Quota Coordinators
```

The public HTTP surface and Service-Binding surface use the same handler and independently revocable caller credentials. The custom public hostname is protected by Cloudflare Access; `workers.dev` remains disabled.

For each request the gateway authenticates and authorizes the caller, filters models through non-negotiable capability/context gates, and concurrently inspects every candidate credential coordinator. Only providers passing admission gates reach the versioned routing policy. The router atomically reserves the policy winner and falls through to the next ranked candidate if it loses a race. Admission accounts for predictive request/token buckets, concurrent reservations, daily budget, and cooldowns. If none can admit, it waits only for a bounded interactive window and otherwise returns `503` with `Retry-After`. Success and failure reconciliation is scheduled with `waitUntil`, so it does not delay SSE bytes.
