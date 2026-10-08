#!/usr/bin/env bash
set -euo pipefail

# Deploys site files to the bucket (created by infra.sh).

export AWS_PAGER=""

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BUCKET="${BUCKET:-$(cat "$ROOT/.bucket")}"
REGION="${REGION:-eu-west-3}"
LAMBDA_URL="$(cat "$ROOT/.lambda-url" 2>/dev/null || true)"
if [[ -z "$LAMBDA_URL" ]]; then
  echo "Fichier .lambda-url absent — lancez d'abord ./scripts/auth.sh" >&2
  exit 1
fi

WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT

# The CSP connect-src must name the Function URL origin, which is only known at
# deploy time: substituted here from .lambda-url (scheme + host, no path).
LAMBDA_ORIGIN=$(printf %s "$LAMBDA_URL" | sed -E 's#^(https?://[^/]+).*#\1#')
sed "s|__LAMBDA_ORIGIN__|$LAMBDA_ORIGIN|" "$ROOT/site/index.html" > "$WORK/index.html"
if grep -q '__LAMBDA_ORIGIN__' "$WORK/index.html"; then
  echo "Substitution CSP échouée — index.html non déployé." >&2
  exit 1
fi
aws s3 cp "$WORK/index.html" "s3://$BUCKET/index.html" \
  --content-type "text/html; charset=utf-8" --cache-control "no-cache"
aws s3 cp "$ROOT/site/style.css" "s3://$BUCKET/style.css" \
  --content-type "text/css; charset=utf-8" --cache-control "no-cache"
aws s3 cp "$ROOT/site/app.js" "s3://$BUCKET/app.js" \
  --content-type "text/javascript; charset=utf-8" --cache-control "no-cache"
aws s3 cp "$ROOT/site/lib.js" "s3://$BUCKET/lib.js" \
  --content-type "text/javascript; charset=utf-8" --cache-control "no-cache"
aws s3 cp "$ROOT/site/cloud.js" "s3://$BUCKET/cloud.js" \
  --content-type "text/javascript; charset=utf-8" --cache-control "no-cache"
aws s3 cp "$ROOT/site/favicon.svg" "s3://$BUCKET/favicon.svg" \
  --content-type "image/svg+xml" --cache-control "max-age=86400"
aws s3 cp "$ROOT/site/favicon.png" "s3://$BUCKET/favicon.png" \
  --content-type "image/png" --cache-control "max-age=86400"

printf "window.CUMULUS_CONFIG = { lambdaUrl: '%s' };\n" "$LAMBDA_URL" > "$WORK/config.js"
aws s3 cp "$WORK/config.js" "s3://$BUCKET/config.js" \
  --content-type "text/javascript; charset=utf-8" --cache-control "no-cache"

echo "Déployé : https://$BUCKET.s3.$REGION.amazonaws.com/index.html"
