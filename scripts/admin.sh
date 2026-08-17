#!/usr/bin/env bash
set -euo pipefail

# Administration (requires AWS access):
#   admin.sh list                  — list all projects across all accounts
#   admin.sh delete <login>/<key>  — delete a project and all its files

export AWS_PAGER=""

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BUCKET="${BUCKET:-$(cat "$ROOT/.bucket")}"

usage() {
  echo "Usage: admin.sh list | delete <login>/<clé>" >&2
  exit 1
}

case "${1:-}" in
  list)
    keys=$(aws s3api list-objects-v2 --bucket "$BUCKET" --prefix projects/ \
      --query "Contents[?ends_with(Key, '/manifest.json')].Key" --output text)
    if [ -z "$keys" ] || [ "$keys" = "None" ]; then
      echo "Aucun projet."
      exit 0
    fi
    for k in $keys; do
      name=$(aws s3 cp "s3://$BUCKET/$k" - 2>/dev/null \
        | node -e 'let d="";process.stdin.on("data",(c)=>d+=c).on("end",()=>console.log(JSON.parse(d).name))' \
        || echo "(manifest illisible)")
      ref="${k#projects/}"
      ref="${ref%/manifest.json}"
      echo "$ref  →  $name"
    done
    ;;
  delete)
    REF="${2:?Usage: admin.sh delete <login>/<clé>}"
    printf 'Suppression DÉFINITIVE de s3://%s/projects/%s/ — confirmer ? [o/N] ' "$BUCKET" "$REF"
    read -r answer
    if [ "$answer" = "o" ]; then
      aws s3 rm "s3://$BUCKET/projects/$REF/" --recursive
    else
      echo "Annulé."
    fi
    ;;
  *)
    usage
    ;;
esac
