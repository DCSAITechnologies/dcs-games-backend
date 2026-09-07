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

COMMIT="$(git rev-parse HEAD)"
BRANCH="$(git rev-parse --abbrev-ref HEAD)"

# Deploy an EXPORT of the commit, never the working tree.
#
# Several agents share this checkout during a sprint, so at any moment there are
# other lanes' half-finished edits sitting next to the committed state. Refusing
# to deploy while any of them exist would block every deploy for the whole
# session; deploying the working tree would ship someone else's work in progress
# under this commit's name. `git archive HEAD` sidesteps both: what is uploaded
# is exactly the tree of the commit recorded in the ledger, and nothing else.
#
# It has a second benefit. `railway up` enumerates files through git, so an
# untracked build stamp never reached the image. The export has no .git, so
# build-info.json travels with it and the running service can name its own
# commit as well as its deployment.
STAGE_DIR="$(mktemp -d)"
trap 'rm -rf "$STAGE_DIR"' EXIT
git archive "$COMMIT" | tar -x -C "$STAGE_DIR"

if [ "$(git rev-parse HEAD)" != "$(git ls-remote origin "refs/heads/$BRANCH" | cut -f1)" ]; then
  echo "REFUSING: HEAD is not pushed. Bank it before deploying, or the deployed code exists on one laptop." >&2
  exit 2
fi

# Stamp INTO the export, so the stamp describes the commit being deployed and
# is never marked dirty by another lane's unrelated edits.
cat > "$STAGE_DIR/build-info.json" <<JSON
{
  "commit": "$COMMIT",
  "branch": "$BRANCH",
  "built_at": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "dirty": false
}
JSON

# Railway keys project links by directory, so the fresh export has none. Link it
# explicitly to the SAME project/environment this checkout is linked to, read
# from the CLI rather than hardcoded — a hardcoded project id is how a "staging"
# script eventually deploys somewhere else.
PROJECT_ID="$(railway status --json | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{process.stdout.write(JSON.parse(s).id||"")})')"
ENVIRONMENT="${RAILWAY_ENV_NAME:-Staging}"
if [ -z "$PROJECT_ID" ]; then echo "REFUSING: could not read the linked project id." >&2; exit 3; fi
if [ "$ENVIRONMENT" != "Staging" ]; then
  echo "REFUSING: this script deploys STAGING only, got '$ENVIRONMENT'." >&2
  exit 3
fi

echo "==> deploying $COMMIT ($BRANCH) to $SERVICE ($ENVIRONMENT)"
( cd "$STAGE_DIR" && railway link --project "$PROJECT_ID" --environment "$ENVIRONMENT" --service "$SERVICE" >/dev/null 2>&1 ) \
  || { echo "REFUSING: could not link the export to project $PROJECT_ID." >&2; exit 3; }
OUT="$(cd "$STAGE_DIR" && railway up --detach --service "$SERVICE" 2>&1)" || { echo "$OUT" >&2; exit 1; }
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
