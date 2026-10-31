#!/usr/bin/env bash
# First-time and repeat deployment to YOUR Cloudflare account.  >>> NOT YET RUN against a real account by the
# authors of this repo (no credentials were available) - read it, run it step by step, and report problems. <<<
#
# Prerequisites: Node 20+, `npx wrangler login` (or CLOUDFLARE_API_TOKEN + CLOUDFLARE_ACCOUNT_ID exported).
# Nothing here upgrades your plan or buys anything: it only creates Free-plan-eligible resources.
set -euo pipefail
cd "$(dirname "$0")/.."

NAME="${WORKER_NAME:-smartmanager-video}"
DB="${D1_NAME:-smartmanager-video}"
BUCKET="${R2_BUCKET:-smartmanager-video-assets}"
QUEUE="${QUEUE_NAME:-smartmanager-video-jobs}"
W="npx wrangler"

echo "==> 1/7 Install & build the PWA"
npm ci
npm run build:pwa

echo "==> 2/7 Create D1 database (skipped if it exists)"
cd worker
if ! $W d1 info "$DB" >/dev/null 2>&1; then $W d1 create "$DB"; fi
DB_ID=$($W d1 info "$DB" --json | node -pe 'JSON.parse(require("fs").readFileSync(0,"utf8")).uuid')
# Patch the id into wrangler.jsonc locally (the placeholder stays in git).
sed -i.bak "s/REPLACE_WITH_D1_DATABASE_ID/$DB_ID/" wrangler.jsonc && rm -f wrangler.jsonc.bak
echo "    D1 id: $DB_ID"

echo "==> 3/7 Create R2 bucket and Queues (skipped if they exist)"
$W r2 bucket create "$BUCKET" 2>/dev/null || echo "    bucket exists"
$W queues create "$QUEUE" 2>/dev/null || echo "    queue exists"
$W queues create "$QUEUE-dlq" 2>/dev/null || echo "    dlq exists"

echo "==> 4/7 Apply D1 migrations (remote)"
$W d1 migrations apply "$DB" --remote

echo "==> 5/7 Secrets (set once; re-run to rotate)"
if ! $W secret list 2>/dev/null | grep -q ENCRYPTION_KEY; then
  node -e 'process.stdout.write(require("crypto").randomBytes(32).toString("base64"))' | $W secret put ENCRYPTION_KEY
  echo "    ENCRYPTION_KEY generated and stored. BACK IT UP: losing it makes every stored Meta token unreadable."
fi
if ! $W secret list 2>/dev/null | grep -q LICENSE_PUBLIC_KEY; then
  echo "    Paste the PRODUCTION license public key (PEM) from the License Generator, then press Ctrl-D:"
  $W secret put LICENSE_PUBLIC_KEY
fi
if ! $W secret list 2>/dev/null | grep -q OWNER_BOOTSTRAP_TOKEN; then
  node -e 'process.stdout.write(require("crypto").randomBytes(24).toString("hex"))' | tee /dev/stderr | $W secret put OWNER_BOOTSTRAP_TOKEN
  echo; echo "    ^ one-time owner bootstrap token (shown once). Use it at POST /owner/api/auth/bootstrap, then delete the secret."
fi

echo "==> 6/7 Deploy the Worker + static assets"
$W deploy

echo "==> 7/7 Smoke test"
echo "    Open https://$NAME.<your-account-subdomain>.workers.dev/healthz  (expect {\"ok\":true,...})"
echo "Done. Next: docs/INSTALLATION.md -> 'Create the platform owner and the first tenant'."
