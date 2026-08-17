#!/usr/bin/env bash
set -euo pipefail

# Usage: ./scripts/infra.sh [bucket-name]
# Creates and configures the S3 bucket (run once, never on an existing bucket).

export AWS_PAGER=""

BUCKET="${1:-cumulus-$(openssl rand -hex 3)}"
REGION="${REGION:-eu-west-3}"
# 30 wildcards '?': enforces exact key length (new: 30 random; legacy: 4 + 26).
QQ='??????????????????????????????'

aws s3api create-bucket \
  --bucket "$BUCKET" --region "$REGION" \
  --create-bucket-configuration LocationConstraint="$REGION"

aws s3api put-bucket-ownership-controls --bucket "$BUCKET" \
  --ownership-controls 'Rules=[{ObjectOwnership=BucketOwnerEnforced}]'

aws s3api put-public-access-block --bucket "$BUCKET" \
  --public-access-block-configuration \
  BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=false,RestrictPublicBuckets=false

POLICY=$(cat <<EOF
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "PublicReadByFullPath",
      "Effect": "Allow",
      "Principal": "*",
      "Action": "s3:GetObject",
      "Resource": "arn:aws:s3:::$BUCKET/*"
    },
    {
      "Sid": "ProjectListWithFullKey",
      "Effect": "Allow",
      "Principal": "*",
      "Action": "s3:ListBucket",
      "Resource": "arn:aws:s3:::$BUCKET",
      "Condition": { "StringLike": { "s3:prefix": "projects/$QQ/*" } }
    }
  ]
}
EOF
)
aws s3api put-bucket-policy --bucket "$BUCKET" --policy "$POLICY"

aws s3api put-bucket-lifecycle-configuration --bucket "$BUCKET" --lifecycle-configuration '{
  "Rules": [{
    "ID": "abort-incomplete-multipart",
    "Status": "Enabled",
    "Filter": { "Prefix": "" },
    "AbortIncompleteMultipartUpload": { "DaysAfterInitiation": 7 }
  }]
}'

echo "$BUCKET" > "$(dirname "$0")/../.bucket"
echo "Bucket créé : $BUCKET"
echo "Ensuite : ./scripts/auth.sh puis ./scripts/deploy.sh"
echo "Site (après deploy.sh) : https://$BUCKET.s3.$REGION.amazonaws.com/index.html"
