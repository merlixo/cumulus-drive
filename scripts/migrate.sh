#!/usr/bin/env bash
set -euo pipefail

# One-shot migration: shortens project keys to 16 characters.
# For each projects/<login>/<key ≠ 16 chars>/, generates a fresh 16-char key,
# moves objects, and prints "old link → new link" to re-share.
# Idempotent: keys already at 16 characters are left untouched.
# Usage: ./scripts/migrate.sh

export AWS_PAGER=""

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BUCKET="${BUCKET:-$(cat "$ROOT/.bucket")}"
REGION="${REGION:-eu-west-3}"
export AWS_DEFAULT_REGION="$REGION"

manifests=$(aws s3api list-objects-v2 --bucket "$BUCKET" --prefix projects/ \
  --query "Contents[?ends_with(Key, '/manifest.json')].Key" --output text)
if [[ -z "$manifests" || "$manifests" == "None" ]]; then
  echo "Aucun projet."
  exit 0
fi

moved=0
for m in $manifests; do
  ref="${m#projects/}"
  ref="${ref%/manifest.json}"
  login="${ref%%/*}"
  key="${ref#*/}"
  # Unexpected path (depth ≠ login/key) is reported, never moved.
  if [[ "$login" == "$key" || "$key" == */* ]]; then
    echo "⚠️  Chemin inattendu, ignoré : projects/$ref/" >&2
    continue
  fi
  if [[ "${#key}" -eq 16 ]]; then
    continue
  fi
  newkey=$(node -e "import('file://$ROOT/site/lib.js').then((l) => console.log(l.generateKey()))")
  echo "Migration : #$login/$key  →  #$login/$newkey"
  aws s3 mv "s3://$BUCKET/projects/$login/$key/" "s3://$BUCKET/projects/$login/$newkey/" --recursive
  moved=$((moved + 1))
done
echo "$moved projet(s) migré(s). Re-partagez les nouveaux liens ci-dessus."
