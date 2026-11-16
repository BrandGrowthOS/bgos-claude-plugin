#!/bin/bash
# Native fixture rig backend for the edit_message evidence, loopback only: the lines of
# e2e/fixture-rig/backend.env (every value a throwaway), this rig's own Postgres and port, the rig's public key.
#   REPO=<worktree> API_PORT=9617 PG_PORT=56417 DB_NAME=editrig bash backend.sh synch|development
set -euo pipefail
: "${REPO:?}" "${API_PORT:?}" "${PG_PORT:?}" "${DB_NAME:?}"
PHASE="${1:?synch or development}"
cd "$REPO/backend"
ENVV=()
while IFS= read -r line; do
  case "$line" in ''|'#'*) continue ;; esac
  ENVV+=("$line")
done < "$REPO/e2e/fixture-rig/backend.env"
KEY="$(node "$REPO/e2e/fixture-rig/rig.mjs" key)"
exec env -i HOME="$HOME" PATH="$PATH" "${ENVV[@]}" \
  NODE_ENV="$PHASE" TZ=UTC HOST=127.0.0.1 PORT="$API_PORT" \
  DB_HOST=127.0.0.1 DB_PORT="$PG_PORT" DB_USERNAME=postgres DB_PASSWORD=postgres DB_DATABASE="$DB_NAME" DB_SSL=false \
  S3_ENDPOINT=http://127.0.0.1:9 PUBLIC_API_BASE_URL="http://127.0.0.1:$API_PORT" \
  CLERK_JWT_KEY="$KEY" \
  NODE_OPTIONS="--require $REPO/e2e/fixture-rig/people-identity.cjs" \
  sh -c "node scripts/run-sql-migrations.js; exec node dist/main.js"
