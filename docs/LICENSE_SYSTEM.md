# Lifetime licensing

## Models
Two license types, both bound to one tenant:

| Type | Expiry | Use |
|---|---|---|
| `LIFETIME` (default) | **no `exp` claim**, ever. The generator refuses to put a date on one and the Worker never expires it | one-time purchase, no subscription |
| `LIMITED` | **`exp` required** (epoch seconds, valid through the end of that UTC day), at most 20 years after issue | trials, fixed-term or periodic arrangements |

The client pays no software subscription for LIFETIME; Meta WhatsApp charges are billed by Meta directly to the client in both cases.

## Token format
Compact JWS, **RS256** (RSASSA-PKCS1-v1_5 + SHA-256): `base64url(header).base64url(payload).base64url(signature)`; a `.smlic` file is
`{ "format": "smlic/1", "token": "<jws>" }`.

| Claim | Meaning |
|---|---|
| `lid` | license ID | `pid` | product ID (`smartmanager-whatsapp-video-funnel`) |
| `client_name`, `tenant_id`, `tenant_slug` | tenant binding | `iat` | issue time (epoch s) |
| `type` | `LIFETIME` or `LIMITED` | `features` | e.g. `video-funnel`, `coexistence` |
| `exp` | only for `LIMITED` | `renews` | optional: this tenant's LIMITED license that this one extends / upgrades |
| `max_numbers` | authorised WhatsApp numbers (1) | `transfer_from` | optional: license being replaced |

## What the Worker enforces (`worker/src/licensing/index.ts`)
Signature · product ID · tenant id **and** slug · type · explicit `exp` if ever present · revocation/suspension/transfer state in D1 · one-license-per-tenant · reuse by another tenant rejected ·
registered WhatsApp number (first verified number is bound; a different one is refused until the owner resets it).
The stored token is **re-verified on every check**, so a swapped public key or tampered row fails closed.

The Worker holds only the **public** key (`LICENSE_PUBLIC_KEY`). The private key exists only in the License Generator.

**Last-known-good grace**: if verification fails *because the Worker's key configuration is broken* (not because the license is bad) and the license verified successfully within 72 h, it stays valid with a warning.
Explicit revocation/suspension is never overridden. (There is no remote licence server, so network outages cannot affect validation.)

## Expiry behaviour (LIMITED)
* The dashboard and License page warn from **30 days** before expiry (owner lists show the date for every license).
* After the expiry date the license is invalid: **automation stops** (the bot sends nothing, in-flight conversations pause with reason `license_expired`, inbound messages are still recorded). Nothing is deleted.
* The grace mechanism never revives an expired license.
* **Renewal**: the owner issues a new token in the Generator (*Renew / Upgrade* tab) with `renews = <old id>` and a later date. The client activates it under *License*; it supersedes the old one, no owner approval needed, and works **even after expiry**. The next time a customer writes, paused conversations resume.
* **Upgrade to LIFETIME**: same flow with no date. A LIFETIME license cannot be renewed (nothing to renew) and a license can only renew **its own tenant's** LIMITED license; revoked/suspended/transferred ones are refused.
* The old license is marked `transferred` in the Worker (status also covers "superseded"); `license_events` records `superseded_by`.

## Lifecycle
* **Issue** (Generator) → send `.smlic` → client activates under *License*.
* **Revoke / suspend / reinstate / reset registered number**: owner portal → Tenants → tenant → Licenses. Revocation is final.
* **Renew / upgrade**: see "Expiry behaviour" above (Generator → *Renew / Upgrade*).
* **Transfer**: (1) Generator → *Transfer License* issues a new token (a LIMITED license keeps its expiry date) with `transfer_from = <old id>` for the new tenant; (2) owner portal → *Approve transfer* (destination tenant id) marks the old license `transferred`; (3) the new tenant can then activate. Without step 2 activation fails with `transfer_not_approved`.

## The License Generator (`apps/license-generator`)
* `SmartManager.Licensing` (.NET 8, portable): signer/verifier, `KeyStore` (RSA-3072, **DPAPI**-protected on Windows via the app, encrypted passphrase backups PBKDF2-600k + AES-256-GCM), local **issued-license register**, `LicenseIssuer`. **14 xunit tests pass** and a token it signs is verified by the Worker (`worker/test/interop.test.ts`).
* `SmartManager.LicenseGenerator` (WPF, net8.0-windows, self-contained single file): Dashboard (with an "expiring within 30 days" counter), Generate (LIFETIME/LIMITED + date picker and +1/3/6-month/+1-year buttons), Issued (type, expiry, "Expired" shown for lapsed limited licenses), Details, Export, Transfer, **Renew / Upgrade**, Key Management, Settings. It is compiled on a Windows runner by `.github/workflows/license-generator.yml` (artifact `SmartManagerLicenseGenerator-win-x64`) but has not been exercised by a human; see docs/TESTING.md.
* Separate **development** and **production** key profiles/registers; a banner shows which is active. Never commit or hard-code production keys (`*.pem`, `*.key`, `*.smlic`, `.dev-keys/` are git-ignored).

### Key management & backup
1. Generate the production key on a trusted Windows PC (Key Management → Generate).
2. Immediately *Export encrypted backup* (passphrase ≥ 12 chars); store the `.smkey` file in two offline places and the passphrase separately.
3. *Copy public key* → `cd worker && npx wrangler secret put LICENSE_PUBLIC_KEY`.
4. If the key is lost: issue a new key, update `LICENSE_PUBLIC_KEY`, and re-issue every client license (old ones stop verifying). Keep the backup safe to avoid this.
