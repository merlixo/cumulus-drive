#!/usr/bin/env bash
set -euo pipefail

# Usage: ./scripts/infra.sh [bucket-name]
# Creates and configures the S3 bucket (run once, never on an existing bucket).

export AWS_PAGER=""

BUCKET="${1:-cumulus-$(openssl rand -hex 3)}"
REGION="${REGION:-eu-west-3}"

aws s3api create-bucket \
  --bucket "$BUCKET" --region "$REGION" \
  --create-bucket-configuration LocationConstraint="$REGION"

aws s3api put-bucket-ownership-controls --bucket "$BUCKET" \
  --ownership-controls 'Rules=[{ObjectOwnership=BucketOwnerEnforced}]'

aws s3api put-public-access-block --bucket "$BUCKET" \
  --public-access-block-configuration \
  BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=false,RestrictPublicBuckets=false

# No bucket policy here on purpose: auth.sh is its sole owner
# (apply_bucket_policy rebuilds it entirely from the registry, and
# put-bucket-policy replaces — it never merges). A policy written here could
# only drift, and any grant wider than the explicit site-file list would make
# auth/accounts.json publicly readable. The bucket stays private until the
# first ./scripts/auth.sh create.

aws s3api put-bucket-lifecycle-configuration --bucket "$BUCKET" --lifecycle-configuration '{
  "Rules": [{
    "ID": "abort-incomplete-multipart",
    "Status": "Enabled",
    "Filter": { "Prefix": "" },
    "AbortIncompleteMultipartUpload": { "DaysAfterInitiation": 7 }
  }]
}'

echo "$BUCKET" > "$(dirname "$0")/../.bucket"
echo "Bucket créé : $BUCKET (privé — aucune politique publique pour l'instant)"
echo "Ensuite : ./scripts/auth.sh create <login> puis ./scripts/deploy.sh"
echo "Site (après deploy.sh) : https://$BUCKET.s3.$REGION.amazonaws.com/index.html"
