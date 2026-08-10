#!/usr/bin/env bash

set -Eeuo pipefail
set +x
IFS=$'\n\t'
umask 077

SCRIPT_PATH=${BASH_SOURCE[0]}
SCRIPT_PARENT=.
[[ "$SCRIPT_PATH" != */* ]] || SCRIPT_PARENT=${SCRIPT_PATH%/*}
SCRIPT_DIR=$(CDPATH='' cd -- "$SCRIPT_PARENT" && pwd)
METADATA_HELPER="$SCRIPT_DIR/backup-metadata.mjs"
BACKUP_SCRIPT="$SCRIPT_DIR/backup.sh"
SCRATCH=''

cleanup() {
  local status=$?
  trap - EXIT HUP INT TERM
  if [[ -n "$SCRATCH" && -d "$SCRATCH" ]]; then
    rm -r -- "$SCRATCH"
  fi
  exit "$status"
}
trap cleanup EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

die() {
  printf '%s\n' 'Backup authentication failed.' >&2
  exit 1
}

require_value() {
  local name=$1
  [[ -n ${!name:-} ]] || die
  [[ ${!name} != *$'\n'* && ${!name} != *$'\r'* ]] || die
}

for variable in \
  BACKUP_SOURCE_PROJECT_REF BACKUP_SOURCE_ENDPOINT BACKUP_SOURCE_AUTH_ANON_KEY \
  BACKUP_SOURCE_AUTH_EMAIL BACKUP_SOURCE_AUTH_PASSWORD BACKUP_SOURCE_AUTH_USER_ID; do
  require_value "$variable"
done

for tool in node curl mktemp chmod rm wc tr; do
  command -v "$tool" >/dev/null 2>&1 || die
done
[[ -f "$METADATA_HELPER" && -x "$BACKUP_SCRIPT" ]] || die

[[ "$BACKUP_SOURCE_PROJECT_REF" =~ ^[a-z0-9]{20}$ ]] || die
[[ ${#BACKUP_SOURCE_AUTH_ANON_KEY} -le 4096 ]] || die
[[ "$BACKUP_SOURCE_AUTH_ANON_KEY" =~ ^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$ ]] || die
[[ ${#BACKUP_SOURCE_AUTH_EMAIL} -le 320 ]] || die
[[ "$BACKUP_SOURCE_AUTH_EMAIL" =~ ^[A-Za-z0-9.!#$%\&\'*+/=?^_\`{|}~-]+@[A-Za-z0-9.-]+$ ]] || die
[[ ${#BACKUP_SOURCE_AUTH_PASSWORD} -ge 12 && ${#BACKUP_SOURCE_AUTH_PASSWORD} -le 1024 ]] || die
[[ "$BACKUP_SOURCE_AUTH_USER_ID" =~ ^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$ ]] || die

canonical_source=$(node "$METADATA_HELPER" canonical-endpoint --value "$BACKUP_SOURCE_ENDPOINT" 2> /dev/null) || die
[[ "$canonical_source" == "https://$BACKUP_SOURCE_PROJECT_REF.storage.supabase.co/storage/v1/s3" ]] || die
auth_origin="https://$BACKUP_SOURCE_PROJECT_REF.supabase.co"

SCRATCH=$(mktemp -d /tmp/smoking-zen-auth.XXXXXXXX) || die
chmod 700 "$SCRATCH" || die
request="$SCRATCH/request.json"
response="$SCRATCH/response.json"
curl_config="$SCRATCH/curl.conf"
provider_log="$SCRATCH/provider.log"

# The script is intentionally literal JavaScript; values travel through the environment.
# shellcheck disable=SC2016
AUTH_REQUEST_FILE="$request" node -e '
  const fs = require("fs");
  const { BACKUP_SOURCE_AUTH_EMAIL: email, BACKUP_SOURCE_AUTH_PASSWORD: password } = process.env;
  if (!email || !password) process.exit(1);
  fs.writeFileSync(process.env.AUTH_REQUEST_FILE, `${JSON.stringify({ email, password })}\n`, { mode: 0o600 });
' || die

printf '%s\n' \
  "url = \"${auth_origin}/auth/v1/token?grant_type=password\"" \
  "header = \"apikey: ${BACKUP_SOURCE_AUTH_ANON_KEY}\"" \
  'header = "Content-Type: application/json"' \
  "data-binary = \"@${request}\"" \
  "output = \"${response}\"" \
  'proto = "=https"' \
  'tlsv1.2' \
  'silent' \
  'show-error' \
  'fail' \
  'max-time = 30' > "$curl_config" || die
printf '%s\n' 'max-filesize = 16384' >> "$curl_config" || die
: > "$response"
: > "$provider_log"
chmod 600 "$request" "$response" "$curl_config" "$provider_log" || die

curl --config "$curl_config" 2> "$provider_log" || die
response_bytes=$(wc -c < "$response" | tr -d ' ')
[[ "$response_bytes" =~ ^[0-9]+$ && "$response_bytes" -ge 2 && "$response_bytes" -le 16384 ]] || die

BACKUP_SOURCE_SESSION_TOKEN=$(AUTH_RESPONSE_FILE="$response" EXPECTED_AUTH_EMAIL="$BACKUP_SOURCE_AUTH_EMAIL" \
  EXPECTED_AUTH_USER_ID="$BACKUP_SOURCE_AUTH_USER_ID" node -e '
  const fs = require("fs");
  let value;
  try { value = JSON.parse(fs.readFileSync(process.env.AUTH_RESPONSE_FILE, "utf8")); } catch { process.exit(1); }
  const token = value?.access_token;
  if (value?.token_type?.toLowerCase() !== "bearer"
    || !Number.isSafeInteger(value?.expires_in) || value.expires_in < 60 || value.expires_in > 3600
    || value?.user?.id !== process.env.EXPECTED_AUTH_USER_ID
    || value?.user?.email !== process.env.EXPECTED_AUTH_EMAIL
    || typeof token !== "string" || token.length > 4096
    || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(token)) process.exit(1);
  process.stdout.write(token);
') || die

export BACKUP_SOURCE_SESSION_TOKEN
unset BACKUP_SOURCE_AUTH_EMAIL BACKUP_SOURCE_AUTH_PASSWORD
"$BACKUP_SCRIPT"
