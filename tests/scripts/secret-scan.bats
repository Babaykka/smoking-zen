#!/usr/bin/env bats
# shellcheck disable=SC2016

setup() {
  TEST_ROOT="$BATS_TEST_TMPDIR/runtime"
  FAKE_BIN="$TEST_ROOT/bin"
  FAKE_LOG="$TEST_ROOT/calls.log"
  mkdir -p "$FAKE_BIN"
  : > "$FAKE_LOG"
  printf '%s\n' '#!/usr/bin/env bash' \
    'set -Eeuo pipefail' \
    'printf "gitleaks" >> "$FAKE_LOG"; for arg in "$@"; do printf " <%s>" "$arg" >> "$FAKE_LOG"; done; printf "\n" >> "$FAKE_LOG"' \
    'target=${2:-}; report=""; expected_exit=1' \
    'while (($#)); do case "$1" in --report-path) report=$2; shift 2;; --exit-code) expected_exit=$2; shift 2;; *) shift;; esac; done' \
    'if [[ $target == *canary* ]]; then' \
    '  [[ ${FAKE_CANARY_DETECT:-1} == 1 ]] || exit 0' \
    '  grep -Eq "ghp_[A-Za-z0-9]{36}" "$target/check.env" || exit 0' \
    '  printf "[{\"RuleID\":\"github-pat\",\"Secret\":\"REDACTED\"}]\n" > "$report"' \
    '  exit "$expected_exit"' \
    'fi' \
    'exit "${FAKE_REPOSITORY_STATUS:-0}"' > "$FAKE_BIN/gitleaks"
  chmod +x "$FAKE_BIN/gitleaks"
  export TEST_ROOT FAKE_BIN FAKE_LOG
  export TMPDIR="$BATS_TEST_TMPDIR"
  export PATH="$FAKE_BIN:$PATH"
  SCAN_SCRIPT="$(cd "$BATS_TEST_DIRNAME/../.." && pwd)/scripts/scan-secrets.sh"
}

@test "secret scan proves a non-stopword PAT canary is detected before scanning the repository" {
  run "$SCAN_SCRIPT"
  [ "$status" -eq 0 ]
  [ "$(grep -c '^gitleaks ' "$FAKE_LOG")" -eq 4 ]
  first=$(sed -n '1p' "$FAKE_LOG")
  second=$(sed -n '2p' "$FAKE_LOG")
  third=$(sed -n '3p' "$FAKE_LOG")
  fourth=$(sed -n '4p' "$FAKE_LOG")
  [[ "$first" == *'<--exit-code> <23>'* ]]
  [[ "$first" == *'<--redact>'* ]]
  [[ "$second" == *'<dir> <.>'* ]]
  [[ "$second" == *'<--redact>'* ]]
  [[ "$second" == *'<--config> <.gitleaks.toml>'* ]]
  [[ "$third" == *'<dir> <.next/static>'* ]]
  [[ "$third" == *'<--redact>'* ]]
  [[ "$third" == *'<--config> <.gitleaks.toml>'* ]]
  [[ "$fourth" == *'<dir> <.next/server>'* ]]
  [[ "$fourth" == *'<--redact>'* ]]
  [[ "$fourth" == *'<--config> <.gitleaks.toml>'* ]]
  [[ "$output$(cat "$FAKE_LOG")" != *'ghp_'* ]]
  [ -z "$(find "$BATS_TEST_TMPDIR" -type d -name 'smoking-zen-gitleaks.*' -print)" ]
}

@test "secret scan fails closed without scanning the repository when the canary is missed" {
  export FAKE_CANARY_DETECT=0
  run "$SCAN_SCRIPT"
  [ "$status" -ne 0 ]
  [ "$(grep -c '^gitleaks ' "$FAKE_LOG")" -eq 1 ]
  [[ "$output" != *'ghp_'* ]]
}
