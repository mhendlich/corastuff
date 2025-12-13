#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
NEW_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"

CONVEX_PORT="${CONVEX_PORT:-3210}"
CONVEX_URL="${CONVEX_URL:-http://localhost:${CONVEX_PORT}}"

cd "${NEW_DIR}"

echo "[convex] starting services..."
docker compose up -d redis convex-backend convex-dashboard

echo "[convex] waiting for backend at ${CONVEX_URL} ..."
for _ in $(seq 1 60); do
  if curl -fsS "${CONVEX_URL}/version" >/dev/null 2>&1; then
    break
  fi
  sleep 1
done

if ! curl -fsS "${CONVEX_URL}/version" >/dev/null 2>&1; then
  echo "[convex] backend did not become ready (url: ${CONVEX_URL})" >&2
  exit 1
fi

ENV_LOCAL="${NEW_DIR}/.env.local"
if [[ -f "${ENV_LOCAL}" ]] && grep -q "^CONVEX_SELF_HOSTED_ADMIN_KEY=" "${ENV_LOCAL}"; then
  echo "[convex] .env.local already has CONVEX_SELF_HOSTED_ADMIN_KEY"
else
  echo "[convex] generating admin key..."
  ADMIN_KEY="$(docker compose exec -T convex-backend ./generate_admin_key.sh | tail -n 1 | tr -d '\r')"
  if [[ -z "${ADMIN_KEY}" ]]; then
    echo "[convex] failed to generate admin key" >&2
    exit 1
  fi
  cat >"${ENV_LOCAL}" <<EOF
# Auto-generated for local Convex self-hosting (do not commit)
CONVEX_SELF_HOSTED_URL='${CONVEX_URL}'
CONVEX_SELF_HOSTED_ADMIN_KEY='${ADMIN_KEY}'
EOF
  echo "[convex] wrote ${ENV_LOCAL}"
fi

CONVEX_BIN="${NEW_DIR}/apps/web/node_modules/.bin/convex"
if [[ ! -x "${CONVEX_BIN}" ]]; then
  echo "[convex] missing convex CLI at ${CONVEX_BIN}" >&2
  echo "[convex] install deps in new/ first (pnpm install) or rebuild the workspace." >&2
  exit 1
fi

echo "[convex] pushing functions/schema..."
"${CONVEX_BIN}" dev --once --typecheck disable --codegen disable

CORASTUFF_PASSWORD="${CORASTUFF_PASSWORD:-dev}"
echo "[convex] setting CORASTUFF_PASSWORD (Convex deployment env)..."
"${CONVEX_BIN}" env set CORASTUFF_PASSWORD "${CORASTUFF_PASSWORD}" || true

echo "[convex] seeding demo sources (no-op if already seeded)..."
SESSION_TOKEN="$(
  "${CONVEX_BIN}" run authActions:login "{\"password\":\"${CORASTUFF_PASSWORD}\",\"kind\":\"service\",\"label\":\"bootstrap\"}" \
    | node -e "const fs=require('fs'); const s=fs.readFileSync(0,'utf8'); const i=s.indexOf('{'); const j=s.lastIndexOf('}'); if(i<0||j<i) process.exit(1); const o=JSON.parse(s.slice(i,j+1)); process.stdout.write(o.sessionToken||'');"
)"
if [[ -n "${SESSION_TOKEN}" ]]; then
  "${CONVEX_BIN}" run sources:seedDemo "{\"sessionToken\":\"${SESSION_TOKEN}\"}" || true
else
  echo "[convex] warning: could not obtain session token; skipping seedDemo" >&2
fi

echo "[convex] done. Dashboard: http://localhost:${CONVEX_DASHBOARD_PORT:-6791}"
