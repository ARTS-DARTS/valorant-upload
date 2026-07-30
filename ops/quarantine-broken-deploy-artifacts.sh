#!/usr/bin/env bash
set -Eeuo pipefail

APP_DIR=/var/www/valorant-upload
QUARANTINE_ROOT=/var/backups/valorant-upload
EXPECTED_PATTERN='^\[[0-9]{4}-[0-9]{2}-[0-9]{2}T[^]]+\] updating [0-9a-f]{40} -$'

case "${1:-}" in
  --dry-run|'') apply_changes=0 ;;
  --apply) apply_changes=1 ;;
  *)
    printf 'Usage: %s [--dry-run|--apply]\n' "$0" >&2
    exit 2
    ;;
esac

mapfile -d '' candidates < <(
  find "$APP_DIR" -maxdepth 1 -type f \
    -regextype posix-extended \
    -regex '.*/[0-9a-f]{40}' \
    -print0
)

if [[ "${#candidates[@]}" -eq 0 ]]; then
  printf 'No broken deploy artifacts found.\n'
  exit 0
fi

for candidate in "${candidates[@]}"; do
  resolved=$(realpath -- "$candidate")
  if [[ "$resolved" != "$APP_DIR"/* ]]; then
    printf 'Refusing unexpected path: %s\n' "$resolved" >&2
    exit 1
  fi
  if [[ "$(stat -c '%s' -- "$resolved")" -ne 80 ]]; then
    printf 'Refusing unexpected size: %s\n' "$resolved" >&2
    exit 1
  fi
  if ! grep -Eq "$EXPECTED_PATTERN" "$resolved"; then
    printf 'Refusing unexpected content: %s\n' "$resolved" >&2
    exit 1
  fi
done

timestamp=$(date -u +%Y%m%dT%H%M%SZ)
quarantine_dir="$QUARANTINE_ROOT/deploy-artifacts-$timestamp"

if [[ "$apply_changes" -ne 1 ]]; then
  printf 'Validated %d artifacts; dry-run only.\n' "${#candidates[@]}"
  exit 0
fi

mkdir -p -- "$quarantine_dir"
chmod 700 "$quarantine_dir"

for candidate in "${candidates[@]}"; do
  mv -- "$candidate" "$quarantine_dir/"
done

printf 'Moved %d validated artifacts to %s\n' \
  "${#candidates[@]}" "$quarantine_dir"
