# Installation

## 1. Local development

```bash
npm install
npm run build:pwa
cd worker
cp .dev.vars.example .dev.vars            # then edit (see below)  - or create it as in README
node scripts/dev-license.mjs init
npx wrangler d1 migrations apply smartmanager-video --local
npx wrangler dev
```

`.dev.vars` (never committed) needs:

| Name | Purpose |
|---|---|
| `ENCRYPTION_KEY` | base64 of 32 random bytes - AES-GCM key protecting tenants' Meta tokens/app secrets |
| `LICENSE_PUBLIC_KEY` | PEM public key; `dev-license.mjs init` writes the dev one |
| `OWNER_BOOTSTRAP_TOKEN` | lets you create the first platform owner once |
| `COOKIE_SECURE=false` | local http only; leave unset (= secure) in production |

## 2. Create the platform owner and the first tenant

```bash
curl -X POST $URL/owner/api/auth/bootstrap -H 'content-type: application/json' \
  -d '{"token":"<OWNER_BOOTSTRAP_TOKEN>","email":"you@example.com","password":"<10+ chars>"}'
```
(or `scripts/create-owner.sh`). Sign in at `$URL/owner/`, press **New tenant**, enter slug/business/admin email/initial password.
The client URL is `$URL/t/<slug>/`. After creating the owner **delete the bootstrap secret**: `npx wrangler secret delete OWNER_BOOTSTRAP_TOKEN`.

## 3. Issue and activate a license

Use the Windows *SmartManager License Generator* (production) or `node scripts/dev-license.mjs issue <tenant-id> <slug> "<Client>"` (development).
Send the `.smlic` file to the client; they paste/load it under **License**. See [LICENSE_SYSTEM.md](LICENSE_SYSTEM.md).

## 4. First-client onboarding checklist (the in-app **Setup** page tracks these)

1. Deploy · 2. Create tenant · 3. Generate lifetime license · 4. Activate it · 5. Give the client the URL
6. Client creates a Meta app / WABA and completes **Coexistence onboarding** ([WHATSAPP_COEXISTENCE_SETUP.md](WHATSAPP_COEXISTENCE_SETUP.md))
7. Enter credentials under **WhatsApp**, press **Verify connection** (must show *coexistence verified*)
8. Set the Meta webhook callback URL + verify token shown on that page; subscribe the five fields
9. Upload videos (MP4, H.264 + AAC, ≤ 16 MB) · 10. Create categories · 11. Build sequences · 12. Edit messages · 13. Set website URL
14. Test the full journey from a personal phone · 15. **Activate automation** on the Setup page

The app refuses to switch automation on until the license is valid, the WhatsApp connection is verified and at least one category has videos.
It only reports "production ready" when every check on the Setup page passes (including that the webhook has actually received an event).
