#!/bin/bash
cd "$(dirname "$0")/../../worker"
pkill -x workerd; fuser -k 8787/tcp 2>/dev/null; sleep 2
rm -rf .wrangler/state
npx wrangler d1 migrations apply smartmanager-video --local 2>&1 | tail -2
setsid nohup npx wrangler dev --local --port 8787 > /tmp/wrangler.log 2>&1 < /dev/null &
for i in $(seq 1 40); do sleep 2; curl -s localhost:8787/healthz >/dev/null && break; done
curl -s -X POST localhost:8787/owner/api/auth/bootstrap -H 'content-type: application/json' -d '{"token":"dev-bootstrap-token","email":"owner@smartmanager.test","password":"owner-password-123"}'; echo
curl -s -c /tmp/owner.jar -X POST localhost:8787/owner/api/auth/login -H 'content-type: application/json' -d '{"email":"owner@smartmanager.test","password":"owner-password-123"}' > /tmp/ologin.json
CSRF=$(node -pe 'JSON.parse(require("fs").readFileSync("/tmp/ologin.json")).csrf')
TID=$(curl -s -b /tmp/owner.jar -X POST localhost:8787/owner/api/tenants -H "x-csrf-token: $CSRF" -H 'content-type: application/json' -d '{"slug":"demo-cafe","business_name":"Demo Café Group","admin_email":"admin@demo.test","admin_password":"demo-password-123"}' | node -pe 'JSON.parse(require("fs").readFileSync(0)).id')
echo "tenant $TID"
node scripts/dev-license.mjs issue $TID demo-cafe "Demo Café Group" | head -1
