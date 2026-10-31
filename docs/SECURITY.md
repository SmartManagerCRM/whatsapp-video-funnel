# Security

## Controls implemented (and where)
| Area | Implementation |
|---|---|
| Passwords | PBKDF2-HMAC-SHA256, per-user 16-byte salt, 100 000 iterations by default (`PASSWORD_HASH_ITERATIONS`, floor 10 000), constant-time compare, dummy hash for unknown users (no user enumeration by timing/message), min length 10 |
| Sessions | 256-bit random token, **only its SHA-256 is stored** in D1; `HttpOnly; SameSite=Strict; Secure` (Secure on by default); cookie `Path=/t/<slug>` so tenants never share a cookie; 7-day absolute expiry; logout deletes server-side; password change revokes other sessions; suspending a tenant purges its sessions |
| CSRF | Mutating requests need `X-CSRF-Token` (per-session secret from `/auth/me`) **and** a same-origin `Origin` |
| Rate limiting | D1 fixed-window: login 20/15 min per IP+tenant and 6/15 min per account; 240 mutating calls/min per session; owner login and bootstrap limited too. Note: the per-account limit lets an attacker lock a specific account out for 15 min (accepted trade-off) |
| AuthZ / tenant isolation | Tenant resolved from the URL slug but a session is only accepted if it was issued for **that** tenant id; every query is `WHERE tenant_id = ?`; cross-tenant references (e.g. another tenant's video in a sequence) are rejected; R2 keys are built server-side from the tenant slug and read via D1 rows, never from request input. Roles: `admin`, `viewer` (read-only); platform owner is a separate table, session kind and cookie path (`/owner`) |
| Secrets | Tenant Meta tokens/app secrets are **AES-256-GCM** encrypted with `ENCRYPTION_KEY` (Worker secret) and **bound to the tenant via AAD** (a blob copied to another tenant won't decrypt); never returned by any API (tests assert it); owner views never select credential columns |
| Webhooks | `X-Hub-Signature-256` HMAC-SHA256 over the raw body with that tenant's app secret, constant-time compare, 401 on mismatch; events for another tenant's phone number id are dropped; idempotency by WhatsApp message id via `UNIQUE(tenant_id,event_key)` |
| Input/output | Parameterised SQL only; JSON validators; React escapes output; CSV export neutralises formula injection; logo upload excludes SVG; website URL must be http(s) |
| Transport/headers | `X-Content-Type-Options`, `X-Frame-Options: DENY`, `Referrer-Policy`, CSP on HTML |
| Service worker | Precaches the static shell only; `/api/` and `/webhook/` are never intercepted/cached (verified in a real browser: no `/api/` entries in Cache Storage) |
| Audit | `audit_logs` for logins, settings, credential changes, license events, exports, deletions; `automation_logs` for engine errors. Logs never include tokens/secrets or request bodies |

## Known gaps / things to decide before wide rollout
* **Free-plan CPU limit**: ~10 ms/request. PBKDF2 at 100 k iterations probably exceeds it on login; lowering iterations weakens hashes (never below 10 k here). Workers Paid removes the issue. Existing hashes keep their own iteration count and can be re-hashed by resetting passwords.
* No MFA and no email-based password reset (the owner resets tenant admins). Plan for TOTP before selling to many clients.
* Uploaded file type is checked by declared MIME and size, not by parsing the container; Meta will reject malformed media (recorded as a failed upload, original kept).
* Slug enumeration: unknown tenant URLs return 404 while known ones show a login page.
* Large uploads are buffered in Worker memory (≤ 16 MB enforced).
* The licence check relies on the Worker's `LICENSE_PUBLIC_KEY`; whoever controls the Cloudflare account can replace it (the platform owner, by design).
* This has had a self-review plus automated tests, **not** an independent penetration test.

## Operational advice
Rotate `ENCRYPTION_KEY` only with a re-encryption migration (not provided - re-entering tokens is the simple path); keep the bootstrap secret deleted after first use; restrict who has Cloudflare dashboard access; keep the License Generator PC and its encrypted key backups offline and separate.
