# Staging and production deployment

The repository defines two isolated Workers:

- Production: `broke-router` using the top-level Wrangler environment.
- Staging: `broke-router-staging` using `--env staging`.

Durable Object bindings and variables are repeated deliberately because Wrangler environment bindings are non-inheritable. The two Workers therefore have separate quota, workflow, queue, event, and learned-policy state.

## One-time secrets

Set each secret independently for staging and production:

```powershell
npx wrangler secret put NVIDIA_API_KEY --env staging
npx wrangler secret put GEMINI_API_KEY --env staging
npx wrangler secret put ADDITIONAL_OPENAI_COMPATIBLE_PROVIDERS_JSON --env staging
npx wrangler secret put CALLER_CREDENTIALS_JSON --env staging

npx wrangler secret put NVIDIA_API_KEY
npx wrangler secret put GEMINI_API_KEY
npx wrangler secret put ADDITIONAL_OPENAI_COMPATIBLE_PROVIDERS_JSON
npx wrangler secret put CALLER_CREDENTIALS_JSON
```

Provider registry JSON is sensitive because it names secret bindings and internal policy configuration, so this project stores it as a secret too.

## Private local access

Keep `workers.dev` disabled. Choose hostnames such as `router-staging.example.com` and `router.example.com`, attach each to its Worker, and create a Cloudflare Access self-hosted application for each hostname. Use a Service Auth policy with a distinct service token for the local laptop.

The laptop sends the Access token headers plus its BrokeRouter credential. Cloudflare-hosted agents continue using Service Bindings and only their BrokeRouter credential.

Official references:

- [Wrangler environments](https://developers.cloudflare.com/workers/wrangler/environments/)
- [Durable Objects and environments](https://developers.cloudflare.com/durable-objects/reference/environments/)
- [Cloudflare Access service tokens](https://developers.cloudflare.com/cloudflare-one/access-controls/service-credentials/service-tokens/)

## CI/CD

Pull requests and `main` pushes run typechecking, unit tests, and production/staging Wrangler dry-run builds. Live provider tests are intentionally excluded because they consume quota and require secrets.

The manual Deploy workflow targets a protected GitHub environment named `staging` or `production`. Add these GitHub environment secrets:

- `CLOUDFLARE_API_TOKEN`
- `CLOUDFLARE_ACCOUNT_ID`

Require reviewer approval for the production GitHub environment. Deploy staging first, run the isolated smoke suite against its Access-protected URL, then approve production.

## Policy rollout

Both environments default to `shadow`. Inspect the learned summary:

```http
GET /v1/routing/stats
GET /v1/routing/policy
GET /v1/routing/evaluation
```

After sufficient shadow evidence, activate adaptive routing:

```http
PUT /v1/routing/policy
Content-Type: application/json

{"mode":"adaptive","explorationRate":0.05,"minObservations":30}
```

Rollback requires no deployment:

```json
{"mode":"baseline","explorationRate":0,"minObservations":30}
```
