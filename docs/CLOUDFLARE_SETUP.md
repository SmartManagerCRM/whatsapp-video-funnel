# Cloudflare setup (Free plan)

> `scripts/deploy.sh` automates steps 2-6 but **has not been run against a real Cloudflare account** by the authors. `wrangler deploy --dry-run`
> (config + bundle validation, 214 KB bundle) and local `wrangler dev` with real D1/R2/Queue emulation were verified.

1. **Account & login**: free account → `npx wrangler login`. Your workers.dev subdomain is shown under *Workers & Pages*.
2. **Resources** (all Free-plan eligible; names are configurable in `worker/wrangler.jsonc`):
   ```bash
   cd worker
   npx wrangler d1 create smartmanager-video          # copy database_id into wrangler.jsonc
   npx wrangler r2 bucket create smartmanager-video-assets
   npx wrangler queues create smartmanager-video-jobs
   npx wrangler queues create smartmanager-video-jobs-dlq
   ```
3. **Migrations**: `npx wrangler d1 migrations apply smartmanager-video --remote`
4. **Secrets**: `ENCRYPTION_KEY` (32 random bytes, base64), `LICENSE_PUBLIC_KEY` (PEM), `OWNER_BOOTSTRAP_TOKEN` (temporary) via `npx wrangler secret put <NAME>`.
   Back up `ENCRYPTION_KEY` offline - without it stored Meta tokens cannot be decrypted (clients would re-enter them).
5. **Build + deploy**: `npm run build:pwa && cd worker && npx wrangler deploy`
6. **Verify**: `curl https://smartmanager-video.<sub>.workers.dev/healthz` → `{"ok":true,...}`; open `/owner/`.

## What runs where
| Piece | Cloudflare product | Notes |
|---|---|---|
| API, webhooks, automation | Worker (`worker/src/index.ts`) | `/t/<slug>/api/*`, `/t/<slug>/webhook/whatsapp`, `/owner/api/*` |
| PWA | Workers Static Assets (`run_worker_first`) | Worker serves `/t/<slug>/…` SPA + per-tenant `manifest.webmanifest` |
| Data | D1 | schema in `database/migrations` |
| Videos | R2 | key = `tenants/<slug>/videos/<id>.mp4` (never client-supplied) |
| Delayed sends / retries | Queues (+ DLQ) | `delaySeconds` ≤ 86 400; longer pauses are kept in D1 and dispatched by the cron |
| Housekeeping | Cron `*/5 * * * *` | handover timeouts, >24 h delayed jobs, lost-message re-dispatch, retention, session cleanup |

## Free-plan limits - be aware (verify current numbers at developers.cloudflare.com/workers/platform/limits)
* **~10 ms CPU per request**: PBKDF2 login hashing may exceed it (error 1102). Mitigate with `PASSWORD_HASH_ITERATIONS` (min 10 000) or Workers Paid ($5/mo). Video sends happen in queue consumers and are mostly I/O wait.
* **D1**: ~100 k rows written/day. A full journey is roughly 40-60 writes → on the order of 1 500-2 000 journeys/day across all tenants.
* **Queues**: ~10 k operations/day on Free. Each message costs several operations (publish/deliver/ack). The owner **Usage** page estimates this and warns at 80 %.
* **R2**: 10 GB storage free. **Request body**: 100 MB (uploads are capped at 16 MB anyway = Meta's limit).
* The app **never** upgrades your plan. When a limit is hit Cloudflare returns errors; queued work stays in Queues/D1 and the owner **Errors** page shows failures. Upgrading to Workers Paid needs no code change.

## workers.dev vs custom domains
`workers.dev` is an initial convenience, not an uptime guarantee. Because every tenant lives under `/t/<slug>/`, moving a client to their own domain later means adding a Worker route/custom domain and
(optionally) redirecting `/t/<slug>/`; the manifest `id/scope/start_url` are derived from the request path, so a custom domain will need a small manifest tweak (serve `/` as the tenant root).
