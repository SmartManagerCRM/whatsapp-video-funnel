#!/usr/bin/env bash
# Creates the first platform owner (one-time) against a deployed Worker.
# usage: BOOTSTRAP_TOKEN=... scripts/create-owner.sh https://smartmanager-video.<sub>.workers.dev owner@example.com
set -euo pipefail
URL="${1:?base url}"; EMAIL="${2:?owner email}"
read -r -s -p "Owner password (10+ chars): " PW; echo
curl -fsS -X POST "$URL/owner/api/auth/bootstrap" -H 'content-type: application/json' \
  -d "$(node -e 'console.log(JSON.stringify({token:process.env.BOOTSTRAP_TOKEN,email:process.argv[1],password:process.argv[2]}))' "$EMAIL" "$PW")"
echo; echo "Owner created. Sign in at $URL/owner/ and then run: npx wrangler secret delete OWNER_BOOTSTRAP_TOKEN"
