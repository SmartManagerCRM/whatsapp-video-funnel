# Lifetime licensing

## Model
One-time, perpetual license per tenant. `type = LIFETIME`, **no `exp` claim** (the generator refuses to create one and the Worker never expires a LIFETIME license).
The client pays no software subscription; Meta WhatsApp charges are billed by Meta directly to the client.

## Token format
Compact JWS, **RS256** (RSASSA-PKCS1-v1_5 + SHA-256): `base64url(header).base64url(payload).base64url(signature)`; a `.smlic` file is
`{ "format": "smlic/1", "token": "<jws>" }`.

| Claim | Meaning |
|---|---|
| `lid` | license ID | `pid` | product ID (`smartmanager-whatsapp-video-funnel`) |
| `client_name`, `tenant_id`, `tenant_slug` | tenant binding | `iat` | issue time (epoch s) |
| `type` | `LIFETIME` | `features` | e.g. `video-funnel`, `coexistence` |
| `max_numbers` | authorised WhatsApp numbers (1) | `transfer_from` | optional: license being replaced |

## What the Worker enforces (`worker/src/licensing/index.ts`)
Signature · product ID · tenant id **and** slug · type · explicit `exp` if ever present · revocation/suspension/transfer state in D1 · one-license-per-tenant · reuse by another tenant rejected ·
registered WhatsApp number (first verified number is bound; a different one is refused until the owner resets it).
The stored token is **re-verified on every check**, so a swapped public key or tampered row fails closed.

The Worker holds only the **public** key (`LICENSE_PUBLIC_KEY`). The private key exists only in the License Generator.

**Last-known-good grace**: if verification fails *because the Worker's key configuration is broken* (not because the license is bad) and the license verified successfully within 72 h, it stays valid with a warning.
Explicit revocation/suspension is never overridden. (There is no remote licence server, so network outages cannot affect validation.)

## Lifecycle
* **Issue** (Generator) → send `.smlic` → client activates under *License*.
* **Revoke / suspend / reinstate / reset registered number**: owner portal → Tenants → tenant → Licenses. Revocation is final.
* **Transfer**: (1) Generator → *Transfer License* issues a new token with `transfer_from = <old id>` for the new tenant; (2) owner portal → *Approve transfer* (destination tenant id) marks the old license `transferred`; (3) the new tenant can then activate. Without step 2 activation fails with `transfer_not_approved`.

## The License Generator (`apps/license-generator`)
* `SmartManager.Licensing` (.NET 8, portable): signer/verifier, `KeyStore` (RSA-3072, **DPAPI**-protected on Windows via the app, encrypted passphrase backups PBKDF2-600k + AES-256-GCM), local **issued-license register**, `LicenseIssuer`. **9 xunit tests pass** and a token it signs is verified by the Worker (`worker/test/interop.test.ts`).
* `SmartManager.LicenseGenerator` (WPF, net8.0-windows, self-contained single file): Dashboard, Generate, Issued, Details, Export, Transfer, Key Management, Settings. **Source only: it could not be compiled here** (the Windows Desktop SDK is unavailable on Linux). XAML well-formedness and handler/control-name consistency were checked; build it on Windows with `scripts/build-license-generator.sh` and report any compile errors.
* Separate **development** and **production** key profiles/registers; a banner shows which is active. Never commit or hard-code production keys (`*.pem`, `*.key`, `*.smlic`, `.dev-keys/` are git-ignored).

### Key management & backup
1. Generate the production key on a trusted Windows PC (Key Management → Generate).
2. Immediately *Export encrypted backup* (passphrase ≥ 12 chars); store the `.smkey` file in two offline places and the passphrase separately.
3. *Copy public key* → `cd worker && npx wrangler secret put LICENSE_PUBLIC_KEY`.
4. If the key is lost: issue a new key, update `LICENSE_PUBLIC_KEY`, and re-issue every client license (old ones stop verifying). Keep the backup safe to avoid this.
