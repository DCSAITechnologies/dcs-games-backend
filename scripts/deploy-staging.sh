#!/usr/bin/env bash
# Deploy to Railway STAGING and PROVE which commit ended up serving.
#
# Two things this exists to prevent, both of which have already happened here:
#
#   1. A Railway variable change silently reverted the service to its
#      GitHub-source build and discarded a `railway up` upload. Every health
#      check stayed green throughout, because "healthy" says nothing about
#      which code is healthy.
#   2. `railway up` enumerates files through git, so an untracked file — such
#      as a generated build stamp — never reaches the image no matter what
#      .railwayignore says. The stamp is therefore a nice-to-have, not the
#      mechanism. RAILWAY_DEPLOYMENT_ID is the mechanism: Railway injects it
#      into every deploy, and /health reports it.
#
# So: deploy, capture the deployment id we just created, then assert the live
# service reports THAT id. If it reports a different one, something reverted
# the deployment and we say so loudly instead of declaring success.
set -euo pipefail
cd "$(dirname "$0")/.."

SERVICE="${SERVICE:-dcs-games-staging}"
URL="${STAGE_URL:-https://dcs-games-backend-staging.up.railway.app}"
LEDGER="reports/DEPLOYMENTS.md"

if [ -n "$(git status --porcelain)" ]; then
  echo "REFUSING: worktree is dirty. Commit first, so the deployed code is a commit that exists." >&2
  git status --short >&2
  exit 2
fi
COMMIT="$(git rev-parse HEAD)"
BRANCH="$(git rev-parse --abbrev-ref HEAD)"

if [ "$(git rev-parse HEAD)" != "$(git ls-remote origin "refs/heads/$BRANCH" | cut -f1)" ]; then
  echo "REFUSING: HEAD is not pushed. Bank it before deploying, or the deployed code exists on one laptop." >&2
  exit 2
fi

node scripts/stamp-build.mjs

echo "==> deploying $COMMIT ($BRANCH) to $SERVICE"
OUT="$(railway up --detach --service "$SERVICE" 2>&1)" || { echo "$OUT" >&2; exit 1; }
echo "$OUT" | tail -2
DEPLOY_ID="$(printf '%s' "$OUT" | sed -n 's/.*[?&]id=\([0-9a-f-]\{36\}\).*/\1/p' | head -1)"
if [ -z "$DEPLOY_ID" ]; then
  echo "REFUSING to claim a deploy: could not read a deployment id from the CLI output." >&2
  exit 3
fi
echo "==> deployment $DEPLOY_ID"

echo "==> waiting for it to serve"
LIVE=""
for _ in $(seq 1 60); do
  LIVE="$(curl -fsS -m 20 "$URL/health" 2>/dev/null \
    | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{process.stdout.write(JSON.parse(s).build?.deployment_id||"")}catch{}})' || true)"
  [ "$LIVE" = "$DEPLOY_ID" ] && break
  printf '.'
  sleep 10
done
echo

if [ "$LIVE" != "$DEPLOY_ID" ]; then
  echo "FAILED: the live service reports deployment '${LIVE:-none}', not the '$DEPLOY_ID' just created." >&2
  echo "        The deployment was reverted or superseded. This is NOT a successful deploy." >&2
  exit 4
fi

mkdir -p "$(dirname "$LEDGER")"
if [ ! -f "$LEDGER" ]; then
  cat > "$LEDGER" <<'HDR'
# Staging deployment ledger

Which commit each running deployment carries. `/health` reports
`build.deployment_id`; look it up here to get the commit.

Written by `scripts/deploy-staging.sh`, which refuses to add a row unless the
live service actually reports the deployment id it just created.

| when (UTC) | deployment id | commit | branch |
| --- | --- | --- | --- |
HDR
fi
printf '| %s | `%s` | `%s` | %s |\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$DEPLOY_ID" "$COMMIT" "$BRANCH" >> "$LEDGER"

echo "==> VERIFIED: $URL is serving deployment $DEPLOY_ID = commit $COMMIT"
echo "==> recorded in $LEDGER"
