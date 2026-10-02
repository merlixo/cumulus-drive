# Cumulus ⛅

Photo and file sharing with friends, 100% S3 + an authentication Lambda — your files literally in a cloud: static site + data in a single bucket. **Accounts**: a login + a password (managed via `auth.sh`); each account creates, lists, and deletes **its own** projects from the home page. A project is shared via a capability link `index.html#<login>/<key>` (key = 16 random characters): anyone with the link can view and upload files (uploads via pre-signed URLs from the Lambda), but never access other people's projects. No anonymous writes on the bucket; the account registry (`auth/accounts.json`, SHA-256 hashes) is never publicly readable. Uploads share the site's origin, so the Lambda — not the uploader — signs how S3 will serve them back: a normalized `Content-Type` (photos and videos kept and served `inline`, anything else `application/octet-stream` + `attachment`) and `If-None-Match: *`. An upload can therefore never be served as a document, nor overwrite an existing file.

## Testing

```bash
node --test tests/lib.test.js tests/zip.test.js tests/handler.test.js   # Node ≥ 20
```

## Deployment

```bash
# 1. (one-time) create the bucket — no bucket policy yet, so it stays fully private
./scripts/infra.sh                    # writes the bucket name to .bucket

# 2. Create an account (prompts for password; re-run = new password)
./scripts/auth.sh create <login>      # Lambda + bucket policy, writes .lambda-url

# 3. (one-time, only for a bucket predating 16-char keys) shorten project keys
./scripts/migrate.sh                  # migrated links will need to be re-shared

# 4. Deploy the site
./scripts/deploy.sh                   # generates config.js, displays site URL
```

Account management: `./scripts/auth.sh list`, `./scripts/auth.sh delete <login>`
(revokes login and anonymous access, deletes all projects owned by the account).

`auth.sh` is the sole owner of the bucket policy: it rebuilds it in full from the
registry on every `create`/`delete`, granting public read on the site files and on
`projects/<login>/*` only — never on the whole bucket, which would expose
`auth/accounts.json`. Use `./scripts/auth.sh sync` to redeploy the Lambda and
re-apply that policy without touching any password.

## Administration

```bash
./scripts/admin.sh list                  # list all projects (audit)
./scripts/admin.sh delete <login>/<key>  # delete a project
```

Recommended: set up an AWS Budgets alert on the account.

## Local Preview (UI only — login, creation, and listing fail locally)

```bash
python3 -m http.server 8080 --directory site
```

## Dev Server (local code, real bucket and Lambda — no deploy)

Serves `site/` and relays Lambda calls, reads and pre-signed uploads to the real
bucket, so changes can be tested end to end (on a phone too) before `deploy.sh`.

```bash
node scripts/dev-server.mjs                     # http://localhost:8080/index.html#<login>/<key>
THROTTLE_KBPS=8000 node scripts/dev-server.mjs  # simulate a slow uplink (8 Mbit/s)
adb reverse tcp:8080 tcp:8080                   # Android phone over USB: same URL on the phone
```
