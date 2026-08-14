#!/bin/sh
set -eu

here="$(cd "$(dirname "$0")" && pwd)"
guard="$here/check-tracked-paths.sh"
repo="$(cd "$here/.." && pwd)"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

cd "$work"
git init --quiet .
git config user.email guard@test.invalid
git config user.name 'guard test'

# Reproduce a forced add past the ignore rule.
printf 'docs/superpowers/\n' > .gitignore
mkdir -p docs/superpowers/plans
printf 'internal plan\n' > docs/superpowers/plans/leak.md
git add .gitignore
git add -f docs/superpowers/plans/leak.md
git commit --quiet -m 'add forbidden fixture'

if out="$(sh "$guard" 2>&1)"; then
  echo "FAIL: guard accepted a tracked internal document" >&2
  exit 1
fi
printf '%s\n' "$out" | grep -q 'docs/superpowers/plans/leak\.md'

git rm -r --quiet --cached docs/superpowers
git commit --quiet -m 'remove forbidden fixture'
sh "$guard" >/dev/null
test -f docs/superpowers/plans/leak.md

cd "$repo"
sh "$guard" >/dev/null
echo "tracked-paths: OK"
