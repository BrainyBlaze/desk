#!/usr/bin/env bash
# One-shot operator action: drop historical false-stuck delivery markers after
# verifying that the messages are already preserved in the channel transcript.
# Reversible: archives every .stuck-submit before deleting. Messages themselves
# live in the channel root.md; these markers are only delivery-retry artifacts.
set -euo pipefail

DESK_HOME="${DESK_HOME:-${HOME}/.config/desk}"
QUEUE="${DESK_HOME}/channels/_engine/queue"
TS="$(date +%Y%m%d-%H%M%S)"
BK="${DESK_HOME}/channels/_engine/stuck-backup-${TS}.tar.gz"
LIST="/tmp/stuck-list-${TS}.txt"

cd "$QUEUE"
find . -name '*.stuck-submit' -o -name '*.stuck-paste' >"$LIST"
BEFORE="$(wc -l <"$LIST")"
echo "stale stuck markers found: ${BEFORE}"
if [ "$BEFORE" -eq 0 ]; then
  echo "nothing to clear"; exit 0
fi

# Archive first (reversible: tar xzf "$BK" -C "$QUEUE" to restore).
tar czf "$BK" -T "$LIST"
ARCHIVED="$(tar tzf "$BK" | grep -c '\.stuck-' || true)"
echo "archived to ${BK}: ${ARCHIVED} entries"
if [ "$ARCHIVED" -lt "$BEFORE" ]; then
  echo "ABORT: archive count ${ARCHIVED} < found ${BEFORE}; not deleting"; exit 1
fi

# Drop the markers (no re-paste — these are unconfirmable/already-delivered).
while IFS= read -r f; do rm -f "$f"; done <"$LIST"
AFTER="$(find . -name '*.stuck-submit' -o -name '*.stuck-paste' | wc -l)"
echo "remaining stuck markers after drop: ${AFTER}"
echo "backup: ${BK}"
