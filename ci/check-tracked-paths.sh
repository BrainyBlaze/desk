#!/bin/sh
set -eu

offenders="$(git ls-files | grep -E '^docs/superpowers/' || true)"

if [ -n "$offenders" ]; then
  echo "FAIL: internal workflow documents are tracked:" >&2
  printf '%s\n' "$offenders" >&2
  exit 1
fi

echo "check-tracked-paths: OK"
