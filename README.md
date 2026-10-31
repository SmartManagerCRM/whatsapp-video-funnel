# SmartManager WhatsApp Video Funnel

A multi-tenant, installable PWA + Cloudflare Worker that automates a WhatsApp video presentation:
a customer messages the business, picks their business category from an interactive list, and receives that
category's video sequence as native WhatsApp video attachments, followed by a website link and a goodbye message.
No AI/LLM is involved - all behaviour is predefined business logic, driven by a persisted state machine.

* **Backend**: Cloudflare Workers (Hono) · D1 · R2 · Queues · Workers Static Assets
* **Frontend**: React + TypeScript + Vite + Tailwind, service worker (Workbox), per-tenant manifest/scope
* **WhatsApp**: official Meta WhatsApp Cloud API with Coexistence (the client keeps using the WhatsApp Business app)
* **Licensing**: LIFETIME (never expires) and LIMITED (expiry date, renewable / upgradable) licenses, RS256-signed with a private key that only exists in the separate Windows *License Generator*
* **Languages & currency**: UI in English / Français / العربية (RTL), bot messages in the same languages, currency picker with all MENA currencies first plus every international currency
* **Cost**: designed for the Cloudflare Free plan; no VPS, Supabase, Firebase, n8n, or AI API

> **Read [docs/TESTING.md](docs/TESTING.md) first** for an honest account of what has and has not been verified.
> In short: 92 Worker tests + 9 .NET tests + a real-browser PWA run pass; the app has **not** been deployed to Cloudflare,
> **not** run against real Meta infrastructure, and the WPF window of the License Generator has **not** been compiled or run (no Windows SDK available).

## Repository layout

```
apps/pwa/                    React PWA (tenant admin + platform-owner area)
apps/license-generator/      .NET 8: Licensing library + tests (portable) and the WPF app (Windows)
worker/                      Cloudflare Worker: API, auth, WhatsApp, automation, licensing, queues, tests
database/migrations/         D1 schema (0001_init.sql)        database/seed/  development seed
docs/                        INSTALLATION, CLOUDFLARE_SETUP, WHATSAPP_COEXISTENCE_SETUP, LICENSE_SYSTEM, SECURITY, BACKUP, USER_GUIDE, TESTING
scripts/                     deploy.sh, create-owner.sh, backup-d1.sh, backup-r2.sh, make-icons.mjs, build-license-generator.sh
tests/e2e/                   Playwright browser run (PWA install/offline/responsive) against `wrangler dev`
```

## Quick start (local)

```bash
npm install                                   # (.npmrc sets legacy-peer-deps: npm's resolver crashes on the vitest peer tree)
npm run build:pwa                             # builds apps/pwa/dist (served by the Worker as static assets)
cd worker
printf 'ENCRYPTION_KEY=%s\nOWNER_BOOTSTRAP_TOKEN=dev-token\nCOOKIE_SECURE=false\n' "$(node -e 'process.stdout.write(require("crypto").randomBytes(32).toString("base64"))')" > .dev.vars
node scripts/dev-license.mjs init             # DEV signing keys (git-ignored) + LICENSE_PUBLIC_KEY in .dev.vars
npx wrangler d1 migrations apply smartmanager-video --local
npx wrangler dev                              # http://localhost:8787
```
Then create the owner and a tenant - see [docs/INSTALLATION.md](docs/INSTALLATION.md).

## Tests

```bash
npm test                                                   # 110 Worker tests in workerd (real D1/R2/Queues bindings, mocked Meta)
npm run typecheck                                          # Worker + PWA
dotnet test apps/license-generator/tests/SmartManager.Licensing.Tests   # 14 tests for the license signer/key store/register
PW=$(node -p "require.resolve('playwright')") bash tests/e2e/setup-local.sh && PW=$PW LIC=worker/.dev-keys/demo-cafe.smlic node tests/e2e/browser.mjs
```

## Deploying

`scripts/deploy.sh` (untested against a real account) creates the D1 database, R2 bucket and Queues, applies migrations,
sets secrets, builds and deploys. Step-by-step manual instructions: [docs/CLOUDFLARE_SETUP.md](docs/CLOUDFLARE_SETUP.md).
Client URLs look like `https://smartmanager-video.<account-subdomain>.workers.dev/t/<slug>/`.

## External prerequisites that still need manual approval (cannot be automated here)

| Item | Why it matters |
|---|---|
| Meta Business verification, a Meta app with the WhatsApp product, and **App Review** for `whatsapp_business_management` / `whatsapp_business_messaging` | Required for production messaging to real customers |
| **Coexistence onboarding** per client number (Embedded Signup coexistence flow, QR link from the WhatsApp Business app) | The number must be on the WhatsApp Business app. This repo verifies the result (`is_on_biz_app`) but does **not** implement Embedded Signup; onboarding is administrator-assisted (see docs) |
| Approved **message template** (optional) | Only needed if you want to re-open conversations outside the 24-hour window |
| Cloudflare account, `wrangler login`, Queues enabled | Deployment |
| Production license key pair (generated in the License Generator on a Windows PC) | Public key is set as the Worker secret `LICENSE_PUBLIC_KEY` |
| Windows machine with Microsoft's .NET 8 Windows Desktop SDK | To build/publish the WPF `SmartManagerLicenseGenerator.exe` |

## Known limitations (also listed in docs/TESTING.md)

* Cloudflare **Free plan CPU limit (~10 ms/request)** may be exceeded by password hashing at login; tune `PASSWORD_HASH_ITERATIONS` or use Workers Paid. See docs/SECURITY.md.
* Meta payload shapes for Coexistence webhooks and the media limits are coded from Meta's documentation and **must be verified with a real test number** before go-live.
* No automatic backups. Use `scripts/backup-*.sh` (docs/BACKUP.md).
* Notification email is stored but no notification emails are sent yet.
* iOS splash screens (`apple-touch-startup-image`) are not generated; Android/desktop install uses the manifest icons and colours.
