#!/usr/bin/env bash
set -euo pipefail

# Account management and authentication infrastructure:
#   auth.sh create <login>  — create an account (re-run = change password),
#                             provisions/updates Lambda, role, and policy
#   auth.sh delete <login>  — delete an account: connection revoked, permissions
#                             removed, ALL its projects erased from bucket
#   auth.sh list            — list logins in registry
#   auth.sh sync            — redeploy Lambda and re-apply policy (without password)

export AWS_PAGER=""

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BUCKET="${BUCKET:-$(cat "$ROOT/.bucket")}"
REGION="${REGION:-eu-west-3}"
export AWS_DEFAULT_REGION="$REGION"   # pin the region for all aws calls
FUNCTION="cumulus-auth"
ROLE="cumulus-auth-role"
SITE_ORIGIN="https://$BUCKET.s3.$REGION.amazonaws.com"
REGISTRY="s3://$BUCKET/auth/accounts.json"

WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT

usage() { echo "Usage: auth.sh create <login> | delete <login> | list | sync" >&2; exit 1; }

download_registry() {
  if ! aws s3 cp "$REGISTRY" "$WORK/accounts.json" >/dev/null 2>&1; then
    echo '{}' > "$WORK/accounts.json"   # first account: brand new registry
  fi
}

upload_registry() {
  aws s3 cp "$WORK/accounts.json" "$REGISTRY" --content-type "application/json" >/dev/null
}

logins() {
  python3 -c 'import json,sys; print("\n".join(sorted(json.load(open(sys.argv[1])))))' "$WORK/accounts.json"
}

# Policy v3, regenerated entirely from registry: GetObject on explicit list
# of site files (never /*, otherwise auth/accounts.json would be readable)
# + per account; ListBucket conditioned per account (full key).
apply_bucket_policy() {
  python3 - "$BUCKET" "$WORK/accounts.json" > "$WORK/policy.json" <<'PY'
import json, sys
bucket, registry = sys.argv[1], sys.argv[2]
logins = sorted(json.load(open(registry)))
arn = f"arn:aws:s3:::{bucket}"
site_files = ["index.html", "style.css", "app.js", "lib.js", "config.js",
              "favicon.svg", "favicon.png"]
qq = "?" * 16  # = KEY_LENGTH in site/lib.js — keep synchronized
statements = [{
    "Sid": "PublicReadSiteAndProjects",
    "Effect": "Allow",
    "Principal": "*",
    "Action": "s3:GetObject",
    "Resource": [f"{arn}/{f}" for f in site_files]
                + [f"{arn}/projects/{l}/*" for l in logins],
}]
if logins:
    statements.append({
        "Sid": "ProjectListWithFullKey",
        "Effect": "Allow",
        "Principal": "*",
        "Action": "s3:ListBucket",
        "Resource": arn,
        "Condition": {"StringLike": {"s3:prefix": [f"projects/{l}/{qq}/*" for l in logins]}},
    })
print(json.dumps({"Version": "2012-10-17", "Statement": statements}, indent=2))
PY
  aws s3api put-bucket-policy --bucket "$BUCKET" --policy "file://$WORK/policy.json"
}

ensure_lambda() {
  ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)
  if ! aws iam get-role --role-name "$ROLE" >/dev/null 2>&1; then
    aws iam create-role --role-name "$ROLE" --assume-role-policy-document '{
      "Version": "2012-10-17",
      "Statement": [{
        "Effect": "Allow",
        "Principal": { "Service": "lambda.amazonaws.com" },
        "Action": "sts:AssumeRole"
      }]
    }' >/dev/null
  fi
  aws iam put-role-policy --role-name "$ROLE" --policy-name s3-project-write --policy-document "{
    \"Version\": \"2012-10-17\",
    \"Statement\": [
      { \"Effect\": \"Allow\", \"Action\": \"s3:GetObject\",
        \"Resource\": [\"arn:aws:s3:::$BUCKET/auth/accounts.json\",
                        \"arn:aws:s3:::$BUCKET/projects/*/*/manifest.json\"] },
      { \"Effect\": \"Allow\", \"Action\": [\"s3:PutObject\", \"s3:DeleteObject\"],
        \"Resource\": \"arn:aws:s3:::$BUCKET/projects/*\" },
      { \"Effect\": \"Allow\", \"Action\": \"s3:ListBucket\",
        \"Resource\": \"arn:aws:s3:::$BUCKET\",
        \"Condition\": { \"StringLike\": { \"s3:prefix\": \"projects/*\" } } }
    ]
  }"
  aws iam attach-role-policy --role-name "$ROLE" \
    --policy-arn arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole
  ROLE_ARN="arn:aws:iam::$ACCOUNT_ID:role/$ROLE"

  mkdir -p "$WORK/pkg/lambda" "$WORK/pkg/site"
  cp "$ROOT/lambda/index.mjs" "$ROOT/lambda/handler.mjs" "$WORK/pkg/lambda/"
  cp "$ROOT/site/lib.js" "$WORK/pkg/site/"
  cp "$ROOT/package.json" "$WORK/pkg/"   # "type": "module" → site/lib.js loaded in ESM
  (cd "$WORK/pkg" && zip -q -r fn.zip package.json lambda site)

  ENV_VARS="Variables={BUCKET=$BUCKET}"
  if aws lambda get-function --function-name "$FUNCTION" >/dev/null 2>&1; then
    aws lambda update-function-code --function-name "$FUNCTION" \
      --zip-file "fileb://$WORK/pkg/fn.zip" >/dev/null
    aws lambda wait function-updated --function-name "$FUNCTION"
    aws lambda update-function-configuration --function-name "$FUNCTION" \
      --environment "$ENV_VARS" >/dev/null
    aws lambda wait function-updated --function-name "$FUNCTION"
  else
    # IAM propagation of the newly created role can take a few seconds.
    for attempt in $(seq 1 10); do
      if aws lambda create-function --function-name "$FUNCTION" \
        --runtime nodejs22.x --handler lambda/index.handler --role "$ROLE_ARN" \
        --zip-file "fileb://$WORK/pkg/fn.zip" --timeout 10 --memory-size 128 \
        --environment "$ENV_VARS" >/dev/null 2>"$WORK/create-err"; then
        break
      fi
      if [[ "$attempt" -eq 10 ]]; then cat "$WORK/create-err" >&2; exit 1; fi
      sleep 5
    done
    aws lambda wait function-active --function-name "$FUNCTION"
  fi

  CORS="AllowOrigins=$SITE_ORIGIN,AllowMethods=POST,AllowHeaders=content-type"
  if aws lambda get-function-url-config --function-name "$FUNCTION" >/dev/null 2>&1; then
    aws lambda update-function-url-config --function-name "$FUNCTION" \
      --auth-type NONE --cors "$CORS" >/dev/null
  else
    aws lambda create-function-url-config --function-name "$FUNCTION" \
      --auth-type NONE --cors "$CORS" >/dev/null
  fi
  if ! aws lambda get-policy --function-name "$FUNCTION" --query Policy --output text 2>/dev/null \
      | grep -q '"Sid":"public-url"'; then
    aws lambda add-permission --function-name "$FUNCTION" --statement-id public-url \
      --action lambda:InvokeFunctionUrl --principal '*' \
      --function-url-auth-type NONE >/dev/null
  fi
  # Since October 2025, a public URL ALSO requires lambda:InvokeFunction,
  # restricted to calls passing through the URL (condition InvokedViaFunctionUrl).
  if ! aws lambda get-policy --function-name "$FUNCTION" --query Policy --output text 2>/dev/null \
      | grep -q '"Sid":"public-invoke"'; then
    aws lambda add-permission --function-name "$FUNCTION" --statement-id public-invoke \
      --action lambda:InvokeFunction --principal '*' \
      --invoked-via-function-url >/dev/null
  fi

  URL=$(aws lambda get-function-url-config --function-name "$FUNCTION" \
    --query FunctionUrl --output text)
  URL="${URL%/}"
  echo "$URL" > "$ROOT/.lambda-url"
}

case "${1:-}" in
  create)
    LOGIN="${2:?Usage: auth.sh create <login>}"
    if [[ ! "$LOGIN" =~ ^[a-z0-9]{2,16}$ ]]; then
      echo "Login invalide : 2 à 16 caractères parmi [a-z0-9]." >&2
      exit 1
    fi
    read -r -s -p "Mot de passe du compte « $LOGIN » (il ne sera pas affiché) : " PASSWORD
    echo
    [[ -n "$PASSWORD" ]] || { echo "Mot de passe vide." >&2; exit 1; }
    HASH=$(printf %s "$PASSWORD" | shasum -a 256 | awk '{print $1}')
    download_registry
    python3 - "$WORK/accounts.json" "$LOGIN" "$HASH" <<'PY'
import json, sys
path, login, digest = sys.argv[1:4]
accounts = json.load(open(path))
accounts[login] = digest
json.dump(accounts, open(path, "w"), indent=2, sort_keys=True)
PY
    # Policy BEFORE uploading registry: as long as the old
    # policy (GetObject on /*) is in place, accounts.json would be
    # publicly readable. Policy v3 is generated from the local file
    # already up to date.
    apply_bucket_policy
    upload_registry
    ensure_lambda
    echo "Compte « $LOGIN » prêt. Lambda : $(cat "$ROOT/.lambda-url")"
    ;;
  delete)
    LOGIN="${2:?Usage: auth.sh delete <login>}"
    download_registry
    if ! logins | grep -qx "$LOGIN"; then
      echo "Compte « $LOGIN » inconnu." >&2
      exit 1
    fi
    echo "Suppression DÉFINITIVE du compte « $LOGIN » : connexion révoquée, liens"
    echo "morts, et TOUS les fichiers de s3://$BUCKET/projects/$LOGIN/ effacés."
    printf 'Pour confirmer, retapez le login : '
    read -r CONFIRM
    if [[ "$CONFIRM" != "$LOGIN" ]]; then
      echo "Annulé."
      exit 1
    fi
    python3 - "$WORK/accounts.json" "$LOGIN" <<'PY'
import json, sys
path, login = sys.argv[1:3]
accounts = json.load(open(path))
accounts.pop(login, None)
json.dump(accounts, open(path, "w"), indent=2, sort_keys=True)
PY
    apply_bucket_policy   # first revoke anonymous access for account
    upload_registry       # then connection
    aws s3 rm "s3://$BUCKET/projects/$LOGIN/" --recursive   # then files
    echo "Compte « $LOGIN » supprimé."
    ;;
  list)
    download_registry
    logins
    ;;
  sync)
    download_registry
    ensure_lambda
    apply_bucket_policy
    echo "Lambda et politique synchronisées. Lambda : $(cat "$ROOT/.lambda-url")"
    ;;
  *)
    usage
    ;;
esac
