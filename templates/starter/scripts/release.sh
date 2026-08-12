#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."
bump=patch
push=--push
for argument in "$@"; do
  case "$argument" in
    major|minor|patch) bump="$argument" ;;
    [0-9]*.[0-9]*.[0-9]*) bump="$argument" ;;
    --no-push) push="" ;;
    *) echo "Usage: ./scripts/release.sh [major|minor|patch|<MAJOR.MINOR.PATCH>] [--no-push]" >&2; exit 1 ;;
  esac
done
current="$(node --print 'require("./timds.json").version')"
IFS=. read -r major minor patch <<<"$current"
case "$bump" in
  major) version="$((major + 1)).0.0" ;;
  minor) version="${major}.$((minor + 1)).0" ;;
  patch) version="${major}.${minor}.$((patch + 1))" ;;
  *) version="$bump" ;;
esac
echo "Releasing $current -> $version"
npm run release -- "$version" ${push:+"$push"}
