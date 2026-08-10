#!/usr/bin/env bash
#
# Cut a TimDS release.
#
#   ./scripts/release.sh              # bump the patch: 0.1.403 -> 0.1.404
#   ./scripts/release.sh 0.2.0        # release an explicit version
#   ./scripts/release.sh --dry-run    # run every check, change nothing
#   ./scripts/release.sh --yes        # skip the confirmation prompt
#
# This script deliberately stops at `gh release create`. Publishing to npm is
# the job of .github/workflows/release.yml, which authenticates through the
# trusted publisher rather than a long-lived token. Running `npm publish` by
# hand wins the race against CI and leaves that run failing on a version
# conflict, so don't.

set -euo pipefail

RELEASE_BRANCH="master"
PACKAGE_NAME="@dtconcepts/timds"

cd "$(dirname "$0")/.."

version=""
dry_run=false
assume_yes=false

for arg in "$@"; do
  case "$arg" in
    --dry-run) dry_run=true ;;
    --yes|-y) assume_yes=true ;;
    -h|--help) sed -n '3,15p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    -*) echo "Unknown option: ${arg}" >&2; exit 1 ;;
    *)
      if [ -n "$version" ]; then
        echo "Only one version may be given (got '${version}' and '${arg}')." >&2
        exit 1
      fi
      version="$arg"
      ;;
  esac
done

fail() { echo "error: $*" >&2; exit 1; }

for tool in git gh node npm; do
  command -v "$tool" >/dev/null 2>&1 || fail "${tool} is required but not installed."
done

current="$(node -p "require('./package.json').version")"

# Default to the next patch: x.y.z -> x.y.(z+1).
if [ -z "$version" ]; then
  [[ "$current" =~ ^([0-9]+)\.([0-9]+)\.([0-9]+)$ ]] \
    || fail "package.json version '${current}' is not MAJOR.MINOR.PATCH; pass a version explicitly."
  version="${BASH_REMATCH[1]}.${BASH_REMATCH[2]}.$(( BASH_REMATCH[3] + 1 ))"
fi

[[ "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || fail "'${version}' is not MAJOR.MINOR.PATCH."
[ "$version" != "$current" ] || fail "package.json is already at ${version}."

tag="v${version}"

# --- Preflight -------------------------------------------------------------
# Everything below is read-only. The first mutation is `npm version`, well
# after the last check, so a failure here leaves the tree untouched.

branch="$(git rev-parse --abbrev-ref HEAD)"
[ "$branch" = "$RELEASE_BRANCH" ] \
  || fail "on branch '${branch}'; releases are cut from '${RELEASE_BRANCH}'."

[ -z "$(git status --porcelain)" ] \
  || fail "working tree is dirty; commit or stash first."

git fetch --quiet origin "$RELEASE_BRANCH" --tags
[ "$(git rev-parse HEAD)" = "$(git rev-parse "origin/${RELEASE_BRANCH}")" ] \
  || fail "local ${RELEASE_BRANCH} differs from origin/${RELEASE_BRANCH}; pull or push first."

git rev-parse --verify --quiet "refs/tags/${tag}" >/dev/null \
  && fail "tag ${tag} already exists locally."
[ -z "$(git ls-remote --tags origin "refs/tags/${tag}")" ] \
  || fail "tag ${tag} already exists on origin."

# A version already on the registry can never be republished, so catch it here
# rather than letting CI fail after the tag and release are public.
if npm view "${PACKAGE_NAME}@${version}" version >/dev/null 2>&1; then
  fail "${PACKAGE_NAME}@${version} is already published to npm."
fi

echo "==> Running tests"
npm test
echo "==> Checking the package contents"
# npm writes the file listing to stderr, so keep it unless the check fails.
if ! pack_output="$(npm run pack:check 2>&1)"; then
  echo "$pack_output" >&2
  fail "npm run pack:check failed."
fi

echo
echo "  package  ${PACKAGE_NAME}"
echo "  version  ${current} -> ${version}"
echo "  tag      ${tag} at $(git rev-parse --short HEAD)"
echo "  publish  GitHub Actions (trusted publisher), not this script"
echo

if [ "$dry_run" = true ]; then
  echo "Dry run: every check passed, nothing was changed."
  exit 0
fi

if [ "$assume_yes" != true ]; then
  read -r -p "Cut this release? [y/N] " reply
  case "$reply" in
    [yY]|[yY][eE][sS]) ;;
    *) echo "Aborted."; exit 1 ;;
  esac
fi

# --- Release ---------------------------------------------------------------

echo "==> Bumping package.json and tagging"
npm version "$version" -m "Release TimDS %s" >/dev/null

# From here a failure leaves a local commit and tag that are not yet public.
# Undo with: git tag -d ${tag} && git reset --hard HEAD~1
rollback="git tag -d ${tag} && git reset --hard HEAD~1"
trap 'echo; echo "Release failed after the local bump. Undo with:" >&2; echo "  ${rollback}" >&2' ERR

echo "==> Pushing ${RELEASE_BRANCH} and ${tag}"
git push origin "$RELEASE_BRANCH" --follow-tags

echo "==> Creating the GitHub release"
gh release create "$tag" --title "TimDS ${version}" --generate-notes

trap - ERR

echo
echo "Released ${tag}. GitHub Actions is publishing ${PACKAGE_NAME}@${version} now."
echo "Watch it:      gh run watch"
echo "Verify npm:    npm view ${PACKAGE_NAME}@${version} version"
