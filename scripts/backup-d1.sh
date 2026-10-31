#!/usr/bin/env bash
# Exports the production D1 database to a local SQL file. Run regularly: the Free plan has no automatic backup you can rely on.
set -euo pipefail
cd "$(dirname "$0")/../worker"
OUT="${1:-../backups/d1-$(date -u +%Y%m%dT%H%M%SZ).sql}"
mkdir -p "$(dirname "$OUT")"
npx wrangler d1 export "${D1_NAME:-smartmanager-video}" --remote --output "$OUT"
echo "Wrote $OUT  (contains customer data: store it encrypted and offline)"
