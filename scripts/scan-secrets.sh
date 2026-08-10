#!/usr/bin/env bash

set -Eeuo pipefail
set +x
IFS=$'\n\t'
umask 077

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
  printf '%s\n' 'Secret scanner self-check failed.' >&2
  exit 1
}

for tool in gitleaks mktemp chmod rm; do
  command -v "$tool" > /dev/null 2>&1 || die
done

SCRATCH=$(mktemp -d "${TMPDIR:-/tmp}/smoking-zen-gitleaks.XXXXXXXX") || die
chmod 700 "$SCRATCH" || die
canary_dir="$SCRATCH/canary"
mkdir -m 700 "$canary_dir" || die
canary="$canary_dir/check.env"
report="$SCRATCH/report.json"
private_log="$SCRATCH/gitleaks.log"
printf 'SMOKING_ZEN_CANARY=ghp_%s%s\n' \
  'wA9mK2pLxN4vRtQzY6b' 'C8dEfGhJlM0oPq1rS' > "$canary"
: > "$report"
: > "$private_log"
chmod 600 "$canary" "$report" "$private_log" || die

if gitleaks dir "$canary_dir" --exit-code 23 --redact --no-banner \
  --report-format json --report-path "$report" > "$private_log" 2>&1; then
  canary_status=0
else
  canary_status=$?
fi
[[ "$canary_status" -eq 23 && -s "$report" ]] || die

rm -r -- "$SCRATCH"
SCRATCH=''
gitleaks dir . --config .gitleaks.toml --redact --no-banner
gitleaks dir .next/static --config .gitleaks.toml --redact --no-banner
gitleaks dir .next/server --config .gitleaks.toml --redact --no-banner
printf '%s\n' 'Secret scan completed.'
