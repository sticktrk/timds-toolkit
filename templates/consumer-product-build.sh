#!/usr/bin/env bash
set -euo pipefail
mkdir -p "$RUNNER_TEMP/product-output"
docker build --quiet --tag timds-product - <<'IMAGE'
FROM node:22-bookworm
RUN apt-get update && apt-get install -y --no-install-recommends jq libnss3 libatk-bridge2.0-0 libcups2 libxcomposite1 libxdamage1 libxfixes3 libxrandr2 libgbm1 libasound2 fonts-liberation && rm -rf /var/lib/apt/lists/*
IMAGE
docker run --detach --name timds-product --user "$(id -u):$(id -g)" \
  --cap-drop ALL --security-opt no-new-privileges \
  --volume "$GITHUB_WORKSPACE:/input:ro" --workdir /tmp \
  --volume "$RUNNER_TEMP/product-output:/output" \
  --env HOME=/tmp/timds-home --env RUNNER_TEMP=/output --env CI=true \
  --env GITHUB_REPOSITORY --env PULL_REQUEST --env BASE_REF --env START_SHA --env APP \
  --env TIMDS_PREVIEW_BRANCH="$PREVIEW_BRANCH" --env GITHUB_PATH=/dev/null \
  --env PATH=/tmp/timds-home/.local/bin:/usr/local/bin:/usr/bin:/bin \
  timds-product sleep infinity
docker exec --workdir /tmp timds-product sh -ec 'mkdir -p /tmp/timds-home /tmp/work && cp -R /input/. /tmp/work/'
