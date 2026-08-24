#!/usr/bin/env bash
set -Eeuo pipefail

DEPLOYER_API_VERSION=4
if [[ ${1:-} == '--api-version' ]]; then
  printf '%s\n' "$DEPLOYER_API_VERSION"
  exit 0
fi

umask 027

CONTROL_DIR=/var/www/valorant-upload
RELEASES_DIR=/var/www/valorant-upload-releases
CURRENT_LINK=/var/www/valorant-upload-current
LAST_GOOD_LINK=/var/www/valorant-upload-last-good
STATE_DIR=/var/lib/valorant-upload-deploy
LOG_FILE=/var/log/valorant-upload-deploy.log
LOCK_FILE=/var/lock/valorant-upload-deploy.lock
PM2_APP=valorant-upload
READY_URL=http://127.0.0.1:3000/ready
HEALTH_URL=http://127.0.0.1:3000/health
SOURCE_ARCHIVE=${VALORANT_UPLOAD_SOURCE_ARCHIVE:-}
SOURCE_ARCHIVE_SHA256=${VALORANT_UPLOAD_SOURCE_ARCHIVE_SHA256:-}
SOURCE_SHA=${VALORANT_UPLOAD_SOURCE_SHA:-}
EXPECTED_CURRENT_SHA=${VALORANT_UPLOAD_EXPECTED_CURRENT_SHA:-}
ANCESTRY_VERIFIED=${VALORANT_UPLOAD_ANCESTRY_VERIFIED:-0}
ALLOW_ROLLBACK=${VALORANT_UPLOAD_ALLOW_ROLLBACK:-0}
DEPLOY_INITIATOR=${VALORANT_UPLOAD_DEPLOY_INITIATOR:-unknown}

candidate_dir=''
remote_sha=''
rollback_target=''
runtime_switched=0
deployment_committed=0

log() {
  printf '[%s] %s\n' "$(date -Is)" "$*"
}

atomic_link() {
  local target=$1
  local link_path=$2
  local next_link="${link_path}.next.$$"
  rm -f -- "$next_link"
  ln -s -- "$target" "$next_link"
  mv -Tf -- "$next_link" "$link_path"
}

release_sha() {
  local runtime=$1
  if [[ -f "$runtime/.release-sha" ]]; then
    tr -d '\r\n' <"$runtime/.release-sha"
    return
  fi
  git -C "$runtime" rev-parse HEAD 2>/dev/null || true
}

valid_runtime_path() {
  local runtime=$1
  [[ "$runtime" =~ ^${RELEASES_DIR}/[0-9a-f]{40}$ ]]
}

validate_release_archive() {
  local archive=$1
  local expected_sha=$2
  local paths_file types_file marker_file marker_count marker_size

  if [[ ! -f "$archive" || -L "$archive" || ! "$expected_sha" =~ ^[0-9a-f]{40}$ ]]; then
    log 'refusing deploy: release archive validation received invalid input'
    return 1
  fi

  paths_file=$(mktemp)
  types_file=$(mktemp)
  marker_file=$(mktemp)
  if ! LC_ALL=C tar --quoting-style=escape -tf "$archive" >"$paths_file"; then
    log 'refusing deploy: archive file listing failed'
    rm -f -- "$paths_file" "$types_file" "$marker_file"
    return 1
  fi
  if grep -E '(^/|(^|/)\.\.(/|$))' "$paths_file" >/dev/null; then
    log 'refusing deploy: archive contains an unsafe path'
    rm -f -- "$paths_file" "$types_file" "$marker_file"
    return 1
  fi
  marker_count=$(grep -Fxc -- '.valorant-deploy-source-sha' "$paths_file" || true)
  if [[ "$marker_count" != 1 ]]; then
    log 'refusing deploy: archive must contain exactly one source marker'
    rm -f -- "$paths_file" "$types_file" "$marker_file"
    return 1
  fi
  if ! LC_ALL=C tar --quoting-style=escape -tvf "$archive" >"$types_file"; then
    log 'refusing deploy: archive type listing failed'
    rm -f -- "$paths_file" "$types_file" "$marker_file"
    return 1
  fi
  if grep -E '^[^-d]' "$types_file" >/dev/null; then
    log 'refusing deploy: archive may contain only regular files and directories'
    rm -f -- "$paths_file" "$types_file" "$marker_file"
    return 1
  fi
  if ! tar -xOf "$archive" -- '.valorant-deploy-source-sha' >"$marker_file"; then
    log 'refusing deploy: archive source marker could not be read'
    rm -f -- "$paths_file" "$types_file" "$marker_file"
    return 1
  fi
  marker_size=$(wc -c <"$marker_file")
  if [[ "$marker_size" != 40 || "$(<"$marker_file")" != "$expected_sha" ]]; then
    log 'refusing deploy: archive source marker does not match candidate SHA'
    rm -f -- "$paths_file" "$types_file" "$marker_file"
    return 1
  fi
  rm -f -- "$paths_file" "$types_file" "$marker_file"
}

if [[ ${1:-} == '--validate-archive' ]]; then
  if [[ $# -ne 3 ]]; then
    printf '%s\n' 'Usage: deployer --validate-archive ARCHIVE EXPECTED_SHA' >&2
    exit 64
  fi
  validate_release_archive "$2" "$3"
  exit
fi

probe_ready_once() {
  local expected_sha=$1
  local payload
  payload=$(curl --fail --silent --show-error --max-time 3 "$READY_URL") || return 1
  node -e '
    try {
      const payload = JSON.parse(process.argv[1]);
      process.exit(payload?.ok === true && payload?.sha === process.argv[2] ? 0 : 1);
    } catch {
      process.exit(1);
    }
  ' "$payload" "$expected_sha"
}

probe_ready() {
  local expected_sha=$1
  local attempt
  for attempt in {1..15}; do
    if probe_ready_once "$expected_sha"; then
      return 0
    fi
    sleep 1
  done
  return 1
}

probe_health() {
  local attempt
  for attempt in {1..15}; do
    if curl --fail --silent --show-error --max-time 3 "$HEALTH_URL" >/dev/null; then
      return 0
    fi
    sleep 1
  done
  return 1
}

start_runtime() {
  local runtime=$1
  local sha=$2
  pm2 delete "$PM2_APP" >/dev/null 2>&1 || true
  (
    cd "$runtime"
    VALORANT_UPLOAD_RELEASE_DIR="$runtime" \
      DOTENV_CONFIG_PATH="$CONTROL_DIR/.env" \
      SITE_DEPLOY_VERSION="$sha" \
      pm2 start "$runtime/ecosystem.config.cjs" \
        --only "$PM2_APP" --cwd "$runtime" --update-env
  )
}

rollback_runtime() {
  local rollback_sha
  if [[ -z "$rollback_target" || ! -d "$rollback_target" ]] ||
     ! valid_runtime_path "$rollback_target"; then
    log 'rollback unavailable: last-good target is missing'
    return 1
  fi
  rollback_sha=$(release_sha "$rollback_target")
  if [[ ! "$rollback_sha" =~ ^[0-9a-f]{40}$ ]]; then
    log 'rollback unavailable: last-good SHA is invalid'
    return 1
  fi
  log "rolling runtime back to $rollback_sha"
  atomic_link "$rollback_target" "$CURRENT_LINK"
  if ! start_runtime "$rollback_target" "$rollback_sha"; then
    log "automatic rollback failed while starting $rollback_sha"
    return 1
  fi
  if [[ -f "$rollback_target/.release-sha" ]]; then
    if ! probe_ready "$rollback_sha"; then
      log "automatic rollback readiness failed for $rollback_sha"
      return 1
    fi
  else
    if ! probe_health; then
      log "automatic rollback health check failed for $rollback_sha"
      return 1
    fi
  fi
  if ! pm2 save; then
    log "automatic rollback could not persist PM2 state for $rollback_sha"
    return 1
  fi
  log "rollback healthy: $rollback_sha"
}

cleanup() {
  local status=$?
  trap - EXIT
  set +e
  if [[ "$runtime_switched" -eq 1 && "$deployment_committed" -ne 1 ]]; then
    if ! rollback_runtime; then
      log "CRITICAL: automatic rollback failed after candidate $remote_sha"
    fi
    mkdir -p "$STATE_DIR"
    printf '%s %s status=%s\n' "$(date -Is)" "$remote_sha" "$status" \
      >"$STATE_DIR/last-failure"
  fi
  if [[ -n "$candidate_dir" &&
        "$candidate_dir" == "$RELEASES_DIR"/.????????????????????????????????????????.new.* &&
        -d "$candidate_dir" ]]; then
    rm -rf -- "$candidate_dir"
  fi
  if [[ "$SOURCE_ARCHIVE" =~ ^/var/lib/valorant-upload-deploy/incoming/[0-9a-f]{40}-[0-9a-f]{32}\.tar$ &&
        -f "$SOURCE_ARCHIVE" && ! -L "$SOURCE_ARCHIVE" ]]; then
    rm -f -- "$SOURCE_ARCHIVE"
  fi
  exit "$status"
}

ensure_release() {
  local release_dir=$1
  if [[ -d "$release_dir" ]]; then
    if [[ -L "$release_dir" ]]; then
      log "refusing deploy: release path must not be a symlink: $release_dir"
      return 1
    fi
    if [[ "$(release_sha "$release_dir")" == "$remote_sha" &&
          -f "$release_dir/.release-archive-sha256" &&
          "$(tr -d '\r\n' <"$release_dir/.release-archive-sha256")" == "$SOURCE_ARCHIVE_SHA256" ]]; then
      log "using preflighted release $remote_sha"
      return
    fi
    log "refusing deploy: release path exists without matching marker: $release_dir"
    return 1
  fi

  candidate_dir=$(mktemp -d "$RELEASES_DIR/.${remote_sha}.new.XXXXXX")
  log "building isolated release $remote_sha"
  tar --no-same-owner --no-same-permissions -xf "$SOURCE_ARCHIVE" -C "$candidate_dir"
  if [[ ! -f "$candidate_dir/.valorant-deploy-source-sha" ||
        "$(tr -d '\r\n' <"$candidate_dir/.valorant-deploy-source-sha")" != "$remote_sha" ]]; then
    log 'refusing deploy: archive source marker does not match candidate SHA'
    return 1
  fi
  rm -f -- "$candidate_dir/.valorant-deploy-source-sha"
  while IFS= read -r -d '' shell_file; do
    if LC_ALL=C grep $'\r' "$shell_file" >/dev/null; then
      log "refusing deploy: shell script contains CRLF: ${shell_file#"$candidate_dir/"}"
      return 1
    fi
  done < <(find "$candidate_dir" -type f -name '*.sh' -print0)
  (
    cd "$candidate_dir"
    npm ci --omit=optional
    # Preflight tests exercise the same Firebase-backed handlers as production.
    # Let dotenv parse the protected environment; shell-sourcing it is unsafe for
    # quoted or multiline service-account values.
    export DOTENV_CONFIG_PATH="$CONTROL_DIR/.env"
    export NODE_OPTIONS='--import dotenv/config'
    npm run check
    npm run check:billing-results --if-present
    npm run test:billing --if-present
  )
  printf '%s\n' "$remote_sha" >"$candidate_dir/.release-sha"
  printf '%s\n' "$SOURCE_ARCHIVE_SHA256" >"$candidate_dir/.release-archive-sha256"
  mv -- "$candidate_dir" "$release_dir"
  candidate_dir=''
}

exec 9>"$LOCK_FILE"
if ! flock -n 9; then
  log 'deploy already running' >>"$LOG_FILE"
  exit 0
fi

exec >>"$LOG_FILE" 2>&1
trap cleanup EXIT

log 'checking valorant-upload'
mkdir -p "$RELEASES_DIR" "$STATE_DIR"

cd "$CONTROL_DIR"
if [[ -z "$SOURCE_ARCHIVE" || -z "$SOURCE_SHA" ]]; then
  log 'refusing deploy: an explicit source archive and SHA are required; implicit origin/main deploys are disabled'
  exit 1
fi
if [[ ! "$SOURCE_SHA" =~ ^[0-9a-f]{40}$ || ! "$EXPECTED_CURRENT_SHA" =~ ^[0-9a-f]{40}$ ||
      ! "$SOURCE_ARCHIVE_SHA256" =~ ^[0-9a-f]{64}$ ]]; then
  log 'refusing deploy: source SHA, expected current SHA, or archive checksum is invalid'
  exit 1
fi
if [[ ! "$SOURCE_ARCHIVE" =~ ^/var/lib/valorant-upload-deploy/incoming/${SOURCE_SHA}-[0-9a-f]{32}\.tar$ ||
      ! -f "$SOURCE_ARCHIVE" || -L "$SOURCE_ARCHIVE" ]]; then
  log 'refusing deploy: source archive is missing or is a symlink'
  exit 1
fi
if [[ "$(sha256sum "$SOURCE_ARCHIVE" | awk '{print $1}')" != "$SOURCE_ARCHIVE_SHA256" ]]; then
  log 'refusing deploy: source archive checksum does not match'
  exit 1
fi
if ! validate_release_archive "$SOURCE_ARCHIVE" "$SOURCE_SHA"; then
  exit 1
fi
if [[ ! "$DEPLOY_INITIATOR" =~ ^[A-Za-z0-9._:@-]{1,64}$ ]]; then
  log 'refusing deploy: initiator is invalid'
  exit 1
fi
remote_sha=$SOURCE_SHA
log "deploy request: initiator=$DEPLOY_INITIATOR mode=archive expected_current=$EXPECTED_CURRENT_SHA candidate=$remote_sha rollback=$ALLOW_ROLLBACK"

if [[ -e "$LAST_GOOD_LINK" && ! -L "$LAST_GOOD_LINK" ]]; then
  log 'refusing deploy: last-good path exists and is not a symlink'
  exit 1
fi
current_target=$(readlink -f "$CURRENT_LINK" || true)
if ! valid_runtime_path "$current_target"; then
  log 'refusing deploy: current runtime target is outside managed runtime paths'
  exit 1
fi
current_sha=$(release_sha "$current_target")
if [[ "$current_sha" != "$EXPECTED_CURRENT_SHA" ]]; then
  log "refusing deploy: current SHA changed (expected $EXPECTED_CURRENT_SHA, found $current_sha)"
  exit 1
fi
if [[ "$ALLOW_ROLLBACK" != 0 && "$ALLOW_ROLLBACK" != 1 ]]; then
  log 'refusing deploy: rollback flag must be 0 or 1'
  exit 1
fi
if [[ "$remote_sha" != "$current_sha" && "$ALLOW_ROLLBACK" != 1 && "$ANCESTRY_VERIFIED" != 1 ]]; then
  log 'refusing deploy: forward ancestry was not verified by the archive builder'
  exit 1
fi

if [[ "$remote_sha" == "$current_sha" ]] && probe_ready_once "$remote_sha"; then
  log "already healthy: $remote_sha"
  deployment_committed=1
  exit 0
fi

release_dir="$RELEASES_DIR/$remote_sha"
ensure_release "$release_dir"

if [[ "$remote_sha" != "$current_sha" ]]; then
  rollback_target=$current_target
  atomic_link "$current_target" "$LAST_GOOD_LINK"
elif [[ -L "$LAST_GOOD_LINK" ]]; then
  rollback_target=$(readlink -f "$LAST_GOOD_LINK" || true)
  if ! valid_runtime_path "$rollback_target"; then
    log 'refusing deploy: last-good target is outside managed runtime paths'
    exit 1
  fi
fi

log "activating release $remote_sha"
atomic_link "$release_dir" "$CURRENT_LINK"
runtime_switched=1
start_runtime "$release_dir" "$remote_sha"

if ! probe_ready "$remote_sha"; then
  log "deploy failed: readiness did not confirm $remote_sha"
  exit 1
fi

pm2 save
mkdir -p "$STATE_DIR"
printf '%s %s\n' "$(date -Is)" "$remote_sha" >"$STATE_DIR/last-success"
rm -f -- "$STATE_DIR/last-failure"
deployment_committed=1
log "deployed and ready: $remote_sha"
