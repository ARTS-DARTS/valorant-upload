#!/usr/bin/env bash
set -Eeuo pipefail

umask 027

SOURCE_PATH=${1:-}
EXPECTED_SHA256=${2:-}
STABLE_DEPLOYER=/usr/local/sbin/valorant-upload-deployer
LEGACY_ENTRYPOINT=/usr/local/bin/deploy-valorant-upload.sh
INSTALL_LOCK=/var/lock/valorant-upload-deployer-install.lock
RUNTIME_LOCK=/var/lock/valorant-upload-deploy.lock

stable_next=''
legacy_next=''
stable_backup=''
legacy_backup=''
stable_existed=0
legacy_existed=0
stable_old_digest=''
legacy_old_digest=''
stable_old_stat=''
legacy_old_stat=''
stable_was_immutable=0
legacy_was_immutable=0
transaction_started=0
transaction_committed=0

declared_version() {
  local path=$1
  local count version
  count=$(grep -Ec '^DEPLOYER_API_VERSION=[1-9][0-9]*$' "$path" || true)
  [[ "$count" == 1 ]] || return 1
  version=$(sed -n 's/^DEPLOYER_API_VERSION=//p' "$path")
  [[ "$version" =~ ^[1-9][0-9]*$ ]] || return 1
  printf '%s\n' "$version"
}

path_is_immutable() {
  local attrs
  attrs=$(lsattr -d -- "$1" 2>/dev/null || true)
  [[ "${attrs%% *}" == *i* ]]
}

snapshot_path() {
  local path=$1
  local backup_prefix=$2
  local existed_name=$3
  local backup_name=$4
  local digest_name=$5
  local stat_name=$6
  local immutable_name=$7
  local backup digest metadata immutable=0

  if [[ ! -e "$path" && ! -L "$path" ]]; then
    return
  fi
  if [[ ! -f "$path" || -L "$path" ]]; then
    printf 'Refusing deployer install: %s is not a regular file.\n' "$path" >&2
    return 1
  fi
  backup=$(mktemp "$backup_prefix")
  rm -f -- "$backup"
  cp --preserve=mode,ownership,timestamps -- "$path" "$backup"
  digest=$(sha256sum "$path" | awk '{print $1}')
  metadata=$(stat -c '%u:%g:%a' "$path")
  if path_is_immutable "$path"; then immutable=1; fi
  printf -v "$existed_name" '%s' 1
  printf -v "$backup_name" '%s' "$backup"
  printf -v "$digest_name" '%s' "$digest"
  printf -v "$stat_name" '%s' "$metadata"
  printf -v "$immutable_name" '%s' "$immutable"
}

restore_path() {
  local path=$1
  local backup=$2
  local existed=$3
  local digest=$4
  local metadata=$5
  local was_immutable=$6

  if [[ "$existed" == 1 ]]; then
    mv -Tf -- "$backup" "$path" || return 1
    [[ "$(sha256sum "$path" | awk '{print $1}')" == "$digest" ]] || return 1
    [[ "$(stat -c '%u:%g:%a' "$path")" == "$metadata" ]] || return 1
    if [[ "$was_immutable" == 1 ]]; then
      chattr +i "$path" || return 1
      path_is_immutable "$path" || return 1
    else
      chattr -i "$path" 2>/dev/null || true
      ! path_is_immutable "$path" || return 1
    fi
  else
    rm -f -- "$path" || return 1
    [[ ! -e "$path" && ! -L "$path" ]] || return 1
  fi
}

finish() {
  local status=$?
  local rollback_failed=0
  trap - EXIT
  set +e

  if [[ "$transaction_started" == 1 && "$transaction_committed" != 1 ]]; then
    for path in "$STABLE_DEPLOYER" "$LEGACY_ENTRYPOINT"; do
      if [[ -e "$path" || -L "$path" ]]; then chattr -i "$path" 2>/dev/null || true; fi
    done
    restore_path "$STABLE_DEPLOYER" "$stable_backup" "$stable_existed" \
      "$stable_old_digest" "$stable_old_stat" "$stable_was_immutable" || rollback_failed=1
    restore_path "$LEGACY_ENTRYPOINT" "$legacy_backup" "$legacy_existed" \
      "$legacy_old_digest" "$legacy_old_stat" "$legacy_was_immutable" || rollback_failed=1
    if [[ "$rollback_failed" == 1 ]]; then
      printf '%s\n' 'CRITICAL: deployer installer rollback could not restore and verify both previous entrypoints; disabling them.' >&2
      for path in "$STABLE_DEPLOYER" "$LEGACY_ENTRYPOINT"; do
        if [[ -e "$path" && ! -L "$path" ]]; then
          chattr -i "$path" 2>/dev/null || true
          chmod 000 "$path" 2>/dev/null || true
          chattr +i "$path" 2>/dev/null || true
        fi
      done
      status=70
    else
      printf '%s\n' 'Deployer installer failed; both previous entrypoints were restored and verified.' >&2
    fi
  fi

  rm -f -- "$stable_next" "$legacy_next" "$stable_backup" "$legacy_backup"
  exit "$status"
}

if [[ ${EUID:-$(id -u)} -ne 0 ]]; then
  printf '%s\n' 'Refusing deployer install: root is required.' >&2
  exit 1
fi
if [[ ! "$SOURCE_PATH" =~ ^/var/lib/valorant-upload-deploy/incoming/deployer-[0-9a-f]{40}-[0-9a-f]{32}\.sh$ ||
      ! -f "$SOURCE_PATH" || -L "$SOURCE_PATH" ||
      ! "$EXPECTED_SHA256" =~ ^[0-9a-f]{64}$ ]]; then
  printf '%s\n' 'Refusing deployer install: invalid source path or checksum.' >&2
  exit 1
fi

exec 8>"$INSTALL_LOCK"
if ! flock -n 8; then
  printf '%s\n' 'Another deployer installation is already running.' >&2
  exit 1
fi
exec 9>"$RUNTIME_LOCK"
if ! flock -w 60 9; then
  printf '%s\n' 'A runtime deployment did not finish within 60 seconds.' >&2
  exit 1
fi
trap finish EXIT

if [[ "$(sha256sum "$SOURCE_PATH" | awk '{print $1}')" != "$EXPECTED_SHA256" ]]; then
  printf '%s\n' 'Refusing deployer install: source checksum mismatch.' >&2
  exit 1
fi
candidate_version=$(declared_version "$SOURCE_PATH") || {
  printf '%s\n' 'Refusing deployer install: candidate API declaration is invalid.' >&2
  exit 1
}
bash -n "$SOURCE_PATH"

installed_version=0
installed_digest=''
if [[ -e "$STABLE_DEPLOYER" || -L "$STABLE_DEPLOYER" ]]; then
  if [[ ! -f "$STABLE_DEPLOYER" || -L "$STABLE_DEPLOYER" ]]; then
    printf '%s\n' 'Refusing deployer install: stable path is not a regular file.' >&2
    exit 1
  fi
  installed_version=$(declared_version "$STABLE_DEPLOYER") || {
    printf '%s\n' 'Refusing deployer install: installed deployer has no valid API declaration.' >&2
    exit 1
  }
  installed_digest=$(sha256sum "$STABLE_DEPLOYER" | awk '{print $1}')
fi
if [[ -e "$LEGACY_ENTRYPOINT" || -L "$LEGACY_ENTRYPOINT" ]]; then
  if [[ ! -f "$LEGACY_ENTRYPOINT" || -L "$LEGACY_ENTRYPOINT" ]]; then
    printf '%s\n' 'Refusing deployer install: legacy path is not a regular file.' >&2
    exit 1
  fi
fi

if (( candidate_version < installed_version )); then
  printf 'Refusing deployer downgrade from API %s to %s.\n' "$installed_version" "$candidate_version" >&2
  exit 1
fi
if (( candidate_version == installed_version )) && [[ "$installed_digest" != "$EXPECTED_SHA256" ]]; then
  printf 'Refusing unversioned deployer replacement at API %s.\n' "$candidate_version" >&2
  exit 1
fi

stable_next=$(mktemp /usr/local/sbin/.valorant-upload-deployer.next.XXXXXX)
install -o root -g root -m 750 "$SOURCE_PATH" "$stable_next"
[[ "$(sha256sum "$stable_next" | awk '{print $1}')" == "$EXPECTED_SHA256" ]]
[[ "$(declared_version "$stable_next")" == "$candidate_version" ]]
bash -n "$stable_next"

legacy_next=$(mktemp /usr/local/bin/.deploy-valorant-upload-disabled.next.XXXXXX)
printf '%s\n' \
  '#!/usr/bin/env bash' \
  'printf "%s\n" "Legacy VLineups deploy entrypoint is disabled. Use the protected control-plane deployer." >&2' \
  'exit 64' >"$legacy_next"
chown root:root "$legacy_next"
chmod 750 "$legacy_next"
bash -n "$legacy_next"
legacy_expected_digest=$(sha256sum "$legacy_next" | awk '{print $1}')

snapshot_path "$STABLE_DEPLOYER" '/usr/local/sbin/.valorant-upload-deployer.backup.XXXXXX' \
  stable_existed stable_backup stable_old_digest stable_old_stat stable_was_immutable
snapshot_path "$LEGACY_ENTRYPOINT" '/usr/local/bin/.deploy-valorant-upload.backup.XXXXXX' \
  legacy_existed legacy_backup legacy_old_digest legacy_old_stat legacy_was_immutable

transaction_started=1
for path in "$STABLE_DEPLOYER" "$LEGACY_ENTRYPOINT"; do
  if [[ -e "$path" || -L "$path" ]]; then chattr -i "$path"; fi
done
mv -Tf -- "$stable_next" "$STABLE_DEPLOYER"
stable_next=''
mv -Tf -- "$legacy_next" "$LEGACY_ENTRYPOINT"
legacy_next=''
chattr +i "$STABLE_DEPLOYER" "$LEGACY_ENTRYPOINT"

if [[ "$(sha256sum "$STABLE_DEPLOYER" | awk '{print $1}')" != "$EXPECTED_SHA256" ||
      "$(declared_version "$STABLE_DEPLOYER")" != "$candidate_version" ||
      "$(sha256sum "$LEGACY_ENTRYPOINT" | awk '{print $1}')" != "$legacy_expected_digest" ||
      "$(stat -c '%u:%g:%a' "$STABLE_DEPLOYER")" != '0:0:750' ||
      "$(stat -c '%u:%g:%a' "$LEGACY_ENTRYPOINT")" != '0:0:750' ]]; then
  printf '%s\n' 'Deployer installation verification failed.' >&2
  exit 1
fi
if ! path_is_immutable "$STABLE_DEPLOYER" ||
   ! path_is_immutable "$LEGACY_ENTRYPOINT"; then
  printf '%s\n' 'Deployer installation verification failed.' >&2
  exit 1
fi

transaction_committed=1
rm -f -- "$stable_backup" "$legacy_backup"
stable_backup=''
legacy_backup=''
printf 'Protected VLineups deployer API %s installed (%s).\n' "$candidate_version" "$EXPECTED_SHA256"
