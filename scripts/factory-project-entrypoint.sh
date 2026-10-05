#!/bin/bash
set -euo pipefail
[[ ${KESTREL_EXECUTION_USER:-} =~ ^[1-9][0-9]*:[1-9][0-9]*$ ]] || exit 64
execution_uid=${KESTREL_EXECUTION_USER%:*}
execution_gid=${KESTREL_EXECUTION_USER#*:}
mkdir -p /home/codex /run/kestrel-docker /var/lib/docker
chown "$execution_uid:$execution_gid" /home/codex
dockerd --host unix:///run/kestrel-docker.sock --data-root /var/lib/docker \
  --exec-root /run/kestrel-docker > /var/log/kestrel-docker.log 2>&1 &
daemon_pid=$!
cleanup() {
  kill -TERM "$daemon_pid" 2>/dev/null || true
  wait "$daemon_pid" 2>/dev/null || true
}
trap cleanup EXIT
for ((probe=0; probe<120; probe++)); do
  if docker info >/dev/null 2>&1; then break; fi
  kill -0 "$daemon_pid" || { tail -30 /var/log/kestrel-docker.log >&2; exit 70; }
  sleep 0.5
done
docker info >/dev/null
# Only the unprivileged task user can invoke the private daemon through this group.
chown "0:$execution_gid" /run/kestrel-docker.sock
chmod 660 /run/kestrel-docker.sock
run_task() {
  setpriv --reuid "$execution_uid" --regid "$execution_gid" --clear-groups -- "$@"
}
run_task node /usr/local/lib/kestrel-project-preparation.mjs
run_task "$@"
