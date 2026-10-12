#!/usr/bin/env bash
# Release by hand. Without a version the next dated one is taken: today's UTC
# date and the release number that day (2026.10.12-1, then 2026.10.12-2).
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."
version=""
push=--push
for argument in "$@"; do
  case "$argument" in
    [0-9][0-9][0-9][0-9].[0-9][0-9].[0-9][0-9]-[1-9]*) version="$argument" ;;
    --no-push) push="" ;;
    *) echo "Usage: ./scripts/release.sh [YYYY.MM.DD-N] [--no-push]" >&2; exit 1 ;;
  esac
done
current="$(node --print 'require("./timds.json").version')"
echo "Releasing from $current${version:+ -> $version}"
npm run release -- ${version:+"$version"} ${push:+"$push"}
