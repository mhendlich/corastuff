#!/bin/sh
set -eu

CONFIG_PATH="/srv/config.js"

if [ -n "${CONVEX_URL:-}" ]; then
  CONVEX_URL_ESCAPED="$(printf '%s' "$CONVEX_URL" | sed 's/\\/\\\\/g; s/"/\\"/g')"
  printf 'window.__CORASTUFF_CONFIG__ = { CONVEX_URL: "%s" };\n' "$CONVEX_URL_ESCAPED" >"$CONFIG_PATH"
else
  printf 'window.__CORASTUFF_CONFIG__ = {};\n' >"$CONFIG_PATH"
fi

exec caddy run --config /etc/caddy/Caddyfile --adapter caddyfile

