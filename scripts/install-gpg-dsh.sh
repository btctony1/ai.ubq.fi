#!/bin/sh
# Explicit, owner-run upgrade: fence the installed entrypoint, drain legacy calls, then publish.
# No keys are read or removed here; ops/gpg-dsh.sh retains responsibility for seed cleanup.
set -eu
fail() { printf 'gpg-dsh-install: %s\n' "$*" >&2; exit 2; }
[ "$#" -eq 1 ] || fail 'usage: sh scripts/install-gpg-dsh.sh /absolute/path/to/installed/gpg-dsh'
case $1 in /*) ;; *) fail 'the installed helper path must be absolute' ;; esac
case $1 in *'
'*) fail 'the installed helper path must not contain a newline' ;; esac
parent=$(CDPATH='' cd -- "$(dirname -- "$1")" && pwd -P) || fail 'cannot resolve the installation directory'
target=$parent/$(basename -- "$1")
[ "$target" = "$1" ] || fail 'use the canonical installed helper path, without symlinked parents or dot components'
[ -O "$parent" ] || fail 'the installation directory must be owned by this user'
if [ ! -f "$target" ] || [ -L "$target" ] || [ ! -O "$target" ]; then
  fail 'the installed helper must be a regular file owned by this user, not a symlink'
fi
repo=$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd)
source=$repo/ops/gpg-dsh.sh
[ -f "$source" ] || fail 'cannot find the repository helper'
wait_seconds=${GPG_DSH_INSTALL_WAIT_SECONDS:-60}
case $wait_seconds in [1-9] | [1-9][0-9] | [1-5][0-9][0-9] | 600) ;; *) fail 'GPG_DSH_INSTALL_WAIT_SECONDS must be between 1 and 600' ;; esac
uid=$(id -u)
tmp_root=${TMPDIR:-/tmp}
case $tmp_root in /?*) ;; *) fail 'TMPDIR must be an absolute path' ;; esac
legacy_base=${tmp_root%/}/dsh-gnupg
legacy_lock=$legacy_base/$uid.lock
barrier=$target.install-lock
umask 077
mkdir -m 700 "$barrier" 2>/dev/null || fail "installation already fenced at $barrier; do not remove a live installer's barrier"
fenced=false
published=false
cleanup() {
  status=$?
  trap - EXIT HUP INT TERM
  if [ "$fenced" = true ] && [ "$published" = false ]; then
    # Restore before releasing queued calls. If restoration fails, leave the barrier closed.
    mv -f "$barrier/original" "$target" || { printf 'gpg-dsh-install: restore failed; barrier retained at %s\n' "$barrier" >&2; exit 2; }
  fi
  rm -rf "$barrier"
  exit "$status"
}
trap cleanup EXIT
trap 'exit 2' HUP INT TERM
cp -p "$target" "$barrier/original"
install -m 0755 "$source" "$barrier/candidate"
quote() { printf "'"; printf '%s' "$1" | sed "s/'/'\\\\''/g"; printf "'"; }
{
  printf '#!/bin/sh\nGPG_DSH_INSTALL_TARGET='; quote "$target"
  printf '\nGPG_DSH_INSTALL_BARRIER='; quote "$barrier"
  cat <<'GATE'

export GPG_DSH_INSTALL_TARGET GPG_DSH_INSTALL_BARRIER
# Move off the installed pathname in argv so the drainer distinguishes queued and legacy calls.
# Inline code avoids a dependency on barrier files that can disappear before this process opens them.
exec /bin/sh -c '
  while [ -d "$GPG_DSH_INSTALL_BARRIER" ]; do sleep 0.1 2>/dev/null || sleep 1; done
  target=$GPG_DSH_INSTALL_TARGET
  unset GPG_DSH_INSTALL_TARGET GPG_DSH_INSTALL_BARRIER GPG_DSH_INSTALL_PID GPG_DSH_INSTALL_UID
  exec "$target" "$@"
' gpg-dsh-install-wait "$@"
GATE
} >"$barrier/gate"
chmod 0755 "$barrier/gate"
fenced=true
mv -f "$barrier/gate" "$target"
printf 'gpg-dsh-install: entrypoint fenced; draining legacy invocations\n' >&2

# All callers must use this canonical installed entrypoint (the absolute gpg.program path).
# Shells executing its old inode retain it in argv until exec gpg. Also drain every GnuPG client
# owned by this user, including an old call that already released its rebuild lock and exec'd gpg.
export GPG_DSH_INSTALL_TARGET="$target" GPG_DSH_INSTALL_PID=$$ GPG_DSH_INSTALL_UID="$uid"
started=$(date +%s)
waiting=false
while :; do
  snapshot=$(ps -axww -o pid=,uid=,args=) || fail 'cannot enumerate processes; refusing to publish'
  active=$(printf '%s\n' "$snapshot" | awk '
    $2 == ENVIRON["GPG_DSH_INSTALL_UID"] && $1 != ENVIRON["GPG_DSH_INSTALL_PID"] {
      command = $0
      sub(/^[[:space:]]*[0-9]+[[:space:]]+[0-9]+[[:space:]]+/, "", command)
      target = ENVIRON["GPG_DSH_INSTALL_TARGET"]
      at = index(command, target)
      before = substr(command, 1, at - 1)
      after = substr(command, at + length(target), 1)
      shell = before ~ /^([^[:space:]]*\/)?(sh|bash|dash|ksh|zsh)([[:space:]]+-[[:alnum:]-]+)*[[:space:]]+$/
      if ((at > 0 && (at == 1 || shell) && (after == "" || after ~ /[[:space:]]/)) ||
          command ~ /^([^[:space:]]*\/)?gpg(2)?([[:space:]]|$)/ ||
          command ~ /^([^[:space:]]*\/)?(sh|bash|dash|ksh|zsh)[[:space:]]+([^[:space:]]*\/)?gpg(2)?([[:space:]]|$)/) print $1
    }
  ')
  # A legacy caller through another pathname may still be visible via its rebuild lock. Never
  # interpret an unpublished owner, a symlink, or a foreign directory as proof of quiescence.
  if [ -e "$legacy_lock" ] || [ -L "$legacy_lock" ]; then
    if [ -L "$legacy_base" ] || [ ! -O "$legacy_base" ] || [ -L "$legacy_lock" ] || [ ! -d "$legacy_lock" ] || [ ! -O "$legacy_lock" ]; then
      # The old holder may have removed the directory between the existence and ownership probes.
      if [ -e "$legacy_lock" ] || [ -L "$legacy_lock" ]; then fail 'legacy lock is not a real directory owned by this user'; fi
    fi
    owner=$(cat "$legacy_lock/owner" 2>/dev/null) || owner=
    owner_pid=${owner%% *}
    case $owner_pid in
      '' | *[!0-9]* | 0) active=unknown-owner ;;
      *)
        if printf '%s\n' "$snapshot" | awk -v pid="$owner_pid" '$1 == pid { found = 1 } END { exit !found }'; then active=$owner_pid; fi
        ;;
    esac
  fi
  [ -n "$active" ] || break
  if [ "$waiting" = false ]; then
    printf 'gpg-dsh-install: waiting for legacy invocations to exit\n' >&2
    waiting=true
  fi
  now=$(date +%s)
  [ $((now - started)) -lt "$wait_seconds" ] || fail 'timed out draining legacy invocations; original helper will be restored'
  sleep 0.1 2>/dev/null || sleep 1
done

# This short handover must not roll back to legacy after the candidate becomes executable.
trap '' HUP INT TERM
mv -f "$barrier/candidate" "$target"
published=true
printf 'gpg-dsh-install: installed %s after legacy invocations drained\n' "$target"
