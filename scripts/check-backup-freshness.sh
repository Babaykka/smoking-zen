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
SCRATCH=''

cleanup() {
  local status=$?
  trap - EXIT HUP INT TERM
  if [[ -n "$SCRATCH" && -d "$SCRATCH" ]]; then rm -r -- "$SCRATCH"; fi
  exit "$status"
}
trap cleanup EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

die() {
  printf '%s\n' 'Backup freshness verification failed.' >&2
  exit 1
}
require_value() {
  local name=$1
  [[ -n ${!name:-} && ${!name} != *$'\n'* && ${!name} != *$'\r'* ]] || die
}

for variable in BACKUP_SOURCE_PROJECT_REF BACKUP_TARGET_ENDPOINT BACKUP_FRESHNESS_TARGET_ACCESS_KEY_ID \
  BACKUP_FRESHNESS_TARGET_SECRET_ACCESS_KEY BACKUP_TARGET_BUCKET \
  BACKUP_TARGET_PREFIX BACKUP_TARGET_REGION \
  BACKUP_TARGET_FORCE_PATH_STYLE; do
  require_value "$variable"
done
for tool in node rclone date mktemp chmod rm sort mkdir; do
  command -v "$tool" >/dev/null 2>&1 || die
done
[[ -f "$METADATA_HELPER" ]] || die

valid_bucket() {
  local bucket=$1
  [[ ${#bucket} -ge 3 && ${#bucket} -le 63 ]] || return 1
  [[ "$bucket" =~ ^[a-z0-9][a-z0-9.-]*[a-z0-9]$ ]] || return 1
  [[ "$bucket" != *..* && ! "$bucket" =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$ ]]
}
valid_prefix() {
  local prefix=$1 segment
  local -a segments
  [[ "$prefix" == */* && "$prefix" != /* && "$prefix" != */ ]] || return 1
  IFS='/' read -r -a segments <<< "$prefix"
  for segment in "${segments[@]}"; do
    [[ "$segment" =~ ^[A-Za-z0-9][A-Za-z0-9._-]*$ && "$segment" != . && "$segment" != .. ]] || return 1
  done
}
valid_bucket "$BACKUP_TARGET_BUCKET" || die
valid_prefix "$BACKUP_TARGET_PREFIX" || die
[[ "$BACKUP_SOURCE_PROJECT_REF" =~ ^[a-z0-9]{20}$ ]] || die
[[ "$BACKUP_TARGET_REGION" =~ ^[a-z0-9][a-z0-9-]{0,31}$ ]] || die
[[ "$BACKUP_TARGET_FORCE_PATH_STYLE" == 'true' \
  || "$BACKUP_TARGET_FORCE_PATH_STYLE" == 'false' ]] || die
target_endpoint=$(node "$METADATA_HELPER" canonical-endpoint --value "$BACKUP_TARGET_ENDPOINT" 2> /dev/null) || die
case "$target_endpoint" in
  https://*.supabase.co|https://*.supabase.co/*|https://*.supabase.co:*) die ;;
esac

target_access_key=$BACKUP_FRESHNESS_TARGET_ACCESS_KEY_ID
target_secret_key=$BACKUP_FRESHNESS_TARGET_SECRET_ACCESS_KEY
target_region=$BACKUP_TARGET_REGION
target_force_path_style=$BACKUP_TARGET_FORCE_PATH_STYLE
unset BACKUP_FRESHNESS_TARGET_ACCESS_KEY_ID BACKUP_FRESHNESS_TARGET_SECRET_ACCESS_KEY
run_rclone() {
  RCLONE_CONFIG_TARGET_TYPE='s3' RCLONE_CONFIG_TARGET_PROVIDER='Other' \
    RCLONE_CONFIG_TARGET_ACCESS_KEY_ID="$target_access_key" \
    RCLONE_CONFIG_TARGET_SECRET_ACCESS_KEY="$target_secret_key" \
    RCLONE_CONFIG_TARGET_ENDPOINT="$target_endpoint" \
    RCLONE_CONFIG_TARGET_REGION="$target_region" \
    RCLONE_CONFIG_TARGET_FORCE_PATH_STYLE="$target_force_path_style" rclone "$@"
}

SCRATCH=$(mktemp -d "${TMPDIR:-/tmp}/smoking-zen-freshness.XXXXXXXX") || die
chmod 700 "$SCRATCH" || die
config_file="$SCRATCH/rclone.conf"
provider_log="$SCRATCH/provider.log"
: > "$config_file"; : > "$provider_log"
chmod 600 "$config_file" "$provider_log"
target_base="target:$BACKUP_TARGET_BUCKET/$BACKUP_TARGET_PREFIX"
run_rclone lsf "$target_base" --dirs-only --max-depth 1 --config "$config_file" \
  > "$SCRATCH/directories" 2>> "$provider_log" || die
LC_ALL=C sort -r "$SCRATCH/directories" > "$SCRATCH/directories.sorted" || die

latest_manifest=''
while IFS= read -r directory; do
  [[ "$directory" =~ ^([0-9]{8}T[0-9]{6}Z)/$ ]] || continue
  snapshot_id=${BASH_REMATCH[1]}
  candidate="$SCRATCH/$snapshot_id.json"
  run_rclone copyto "$target_base/$snapshot_id/manifest.json" "$candidate" --config "$config_file" \
    > /dev/null 2>> "$provider_log" || continue
  if node "$METADATA_HELPER" validate-manifest --manifest "$candidate" --snapshot "$snapshot_id" \
    > /dev/null 2>> "$provider_log"; then
    latest_manifest=$candidate
    break
  fi
done < "$SCRATCH/directories.sorted"
[[ -n "$latest_manifest" ]] || die

now_id=$(date -u +%Y%m%dT%H%M%SZ)
[[ "$now_id" =~ ^[0-9]{8}T[0-9]{6}Z$ ]] || die
now="${now_id:0:4}-${now_id:4:2}-${now_id:6:2}T${now_id:9:2}:${now_id:11:2}:${now_id:13:2}.000Z"
node "$METADATA_HELPER" freshness --manifest "$latest_manifest" --now "$now" \
  --source-project-ref "$BACKUP_SOURCE_PROJECT_REF" \
  > /dev/null 2>> "$provider_log" || die
printf '%s\n' 'Backup freshness verified.'
