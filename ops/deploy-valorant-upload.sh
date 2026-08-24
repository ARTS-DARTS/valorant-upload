#!/usr/bin/env bash
set -Eeuo pipefail

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
SOURCE_SHA=${VALORANT_UPLOAD_SOURCE_SHA:-}

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
  [[ "$runtime" == "$CONTROL_DIR" ||
     "$runtime" =~ ^${RELEASES_DIR}/[0-9a-f]{40}$ ]]
}

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

sync_control_checkout() {
  if [[ -n "$SOURCE_ARCHIVE" ]]; then
    log 'archive deployment: control checkout was not changed'
    return
  fi
  if git -C "$CONTROL_DIR" merge --ff-only "$remote_sha"; then
    log "control checkout synced to $remote_sha"
  else
    log 'warning: runtime is healthy but the control checkout did not fast-forward'
  fi
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
  start_runtime "$rollback_target" "$rollback_sha"
  if [[ -f "$rollback_target/.release-sha" ]]; then
    probe_ready "$rollback_sha"
  else
    probe_health
  fi
  pm2 save
  log "rollback healthy: $rollback_sha"
}

cleanup() {
  local status=$?
  trap - EXIT
  set +e
  if [[ "$runtime_switched" -eq 1 && "$deployment_committed" -ne 1 ]]; then
    rollback_runtime
    mkdir -p "$STATE_DIR"
    printf '%s %s status=%s\n' "$(date -Is)" "$remote_sha" "$status" \
      >"$STATE_DIR/last-failure"
  fi
  if [[ -n "$candidate_dir" &&
        "$candidate_dir" == "$RELEASES_DIR"/.????????????????????????????????????????.new.* &&
        -d "$candidate_dir" ]]; then
    rm -rf -- "$candidate_dir"
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
    if [[ "$(release_sha "$release_dir")" == "$remote_sha" ]]; then
      log "using preflighted release $remote_sha"
      return
    fi
    log "refusing deploy: release path exists without matching marker: $release_dir"
    return 1
  fi

  candidate_dir=$(mktemp -d "$RELEASES_DIR/.${remote_sha}.new.XXXXXX")
  log "building isolated release $remote_sha"
  if [[ -n "$SOURCE_ARCHIVE" ]]; then
    tar -xf "$SOURCE_ARCHIVE" -C "$candidate_dir"
  else
    git -C "$CONTROL_DIR" archive "$remote_sha" | tar -x -C "$candidate_dir"
  fi
  (
    cd "$candidate_dir"
    set -a
    # Preflight tests exercise the same Firebase-backed handlers as production.
    # Load the protected VPS environment without copying secrets into a release.
    source "$CONTROL_DIR/.env"
    set +a
    npm ci --omit=optional
    npm run check
    npm run check:billing-results --if-present
    npm run test:billing --if-present
  )
  printf '%s\n' "$remote_sha" >"$candidate_dir/.release-sha"
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
if [[ -n "$SOURCE_ARCHIVE" ]]; then
  if [[ ! "$SOURCE_SHA" =~ ^[0-9a-f]{40}$ ]]; then
    log 'refusing deploy: VALORANT_UPLOAD_SOURCE_SHA is invalid'
    exit 1
  fi
  if [[ ! -f "$SOURCE_ARCHIVE" || -L "$SOURCE_ARCHIVE" ]]; then
    log 'refusing deploy: source archive is missing or is a symlink'
    exit 1
  fi
  remote_sha=$SOURCE_SHA
else
  git fetch origin main:refs/remotes/origin/main
  if [[ -n "$(git status --porcelain --untracked-files=no)" ]]; then
    log 'refusing deploy: tracked control-plane files have local changes'
    exit 1
  fi
  remote_sha=$(git rev-parse origin/main)
fi
if [[ ! "$remote_sha" =~ ^[0-9a-f]{40}$ ]]; then
  log 'refusing deploy: origin/main did not resolve to a full SHA'
  exit 1
fi

if [[ -e "$LAST_GOOD_LINK" && ! -L "$LAST_GOOD_LINK" ]]; then
  log 'refusing deploy: last-good path exists and is not a symlink'
  exit 1
fi
if [[ ! -L "$LAST_GOOD_LINK" ]]; then
  atomic_link "$CONTROL_DIR" "$LAST_GOOD_LINK"
fi
rollback_target=$(readlink -f "$LAST_GOOD_LINK" || true)
if ! valid_runtime_path "$rollback_target"; then
  log 'refusing deploy: last-good target is outside managed runtime paths'
  exit 1
fi

if probe_ready_once "$remote_sha"; then
  if [[ -L "$CURRENT_LINK" ]]; then
    current_target=$(readlink -f "$CURRENT_LINK" || true)
    if [[ -n "$current_target" ]] &&
       valid_runtime_path "$current_target" &&
       [[ "$(release_sha "$current_target")" == "$remote_sha" ]]; then
      atomic_link "$current_target" "$LAST_GOOD_LINK"
    fi
  fi
  log "already healthy: $remote_sha"
  sync_control_checkout
  deployment_committed=1
  exit 0
fi

release_dir="$RELEASES_DIR/$remote_sha"
ensure_release "$release_dir"

log "activating release $remote_sha"
atomic_link "$release_dir" "$CURRENT_LINK"
runtime_switched=1
start_runtime "$release_dir" "$remote_sha"

if ! probe_ready "$remote_sha"; then
  log "deploy failed: readiness did not confirm $remote_sha"
  exit 1
fi

pm2 save
atomic_link "$release_dir" "$LAST_GOOD_LINK"
mkdir -p "$STATE_DIR"
printf '%s %s\n' "$(date -Is)" "$remote_sha" >"$STATE_DIR/last-success"
rm -f -- "$STATE_DIR/last-failure"
deployment_committed=1
sync_control_checkout
log "deployed and ready: $remote_sha"
