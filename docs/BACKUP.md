# Backups and data management

**There are no automatic backups in this project, and none should be assumed.** On the Cloudflare Free plan, D1 Time Travel (point-in-time restore) retention is short and R2 has no versioned backups by default -
check the current Cloudflare documentation for what your plan includes. You must export regularly.

## D1 (customers, conversations, settings, licences)
```bash
scripts/backup-d1.sh                      # wrangler d1 export --remote → ./backups/d1-<timestamp>.sql
```
Restore into a fresh database: `npx wrangler d1 execute <db> --remote --file backups/d1-….sql` (create the DB first; the export includes schema).
The dump contains personal data - encrypt it and store it offline. Tokens in it are AES-GCM ciphertext: **also back up `ENCRYPTION_KEY`** or they are unrecoverable.

## R2 (videos, logos)
```bash
rclone config                             # remote "r2", provider Cloudflare, R2 S3 credentials (Object Read)
scripts/backup-r2.sh ./backups/r2
```
Keep originals of every video elsewhere too (the client's own files are the real masters).

## Not backed up by these scripts
Worker secrets (`ENCRYPTION_KEY`, `LICENSE_PUBLIC_KEY`) - store them in a password manager; the License Generator private key - use its *Export encrypted backup*.

## Customer data management (in the PWA)
Export customers to CSV · delete one customer or in bulk (full cascade of messages/events) · **retention** (delete customers idle for N days, enforced by the 5-minute cron) · delete obsolete videos (removes the R2 object) ·
per-customer timeline. Deleting a customer removes their data from D1; Meta/WhatsApp keep their own copies under their own policies.
