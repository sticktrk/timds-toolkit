# Executable download host

Clients download the `timds-cli` executables from a public Cloudflare R2
bucket behind `https://downloads.timds.com/timds-cli/`
(`BINARY_DOWNLOAD_BASE` in `src/binary-installation.mjs`), never from this
repository's GitHub Releases. That keeps every stock workflow and install
working if this repository is private. GitHub Releases still get the
executables attached, for the maintainers' own record.

Each release is served at a fixed address that never changes:

```
https://downloads.timds.com/timds-cli/v<version>/
  timds-cli-v<version>-darwin-arm64        (+ .sha256, .json)
  timds-cli-v<version>-linux-x64           (+ .sha256, .json)
  SHA256SUMS
```

Objects are written once with `Cache-Control: public, max-age=31536000,
immutable`. `scripts/binary-host.mjs` refuses to replace an existing key that
holds different bytes, writes `SHA256SUMS` last, and reads every file back from
the public URL before it succeeds.

## How a release uses it

`release.yml` runs `host-binaries` after the signed, notarized executables are
built and before `publish`. That job verifies the release
(`scripts/binary-release.mjs`), then uploads it with
`node scripts/binary-host.mjs upload <version>`. If the upload or the
read-back fails, npm does not publish, so no npm version ever lacks its
executables. `attach-binaries` still attaches them to the GitHub Release.

## One-time setup

Do these steps in order. Do not merge the change that introduced this host
until steps 1–4 are done: until then, every release would stop at
`host-binaries`, and a binary system that upgraded would download from an
address that does not exist yet.

Steps 1–3 use the Cloudflare CLI (`cf`) and `gh`. The dashboard works too:
R2 → bucket → Settings → Custom Domains, and R2 → Manage API tokens with
**Object Read & Write** on the one bucket.

1. **Bucket.** Create `timds-downloads`. To use another name, set it as the
   repository variable `TIMDS_DOWNLOAD_BUCKET` (and in your shell for step 4).

   ```bash
   cf r2 buckets create --name timds-downloads
   ```

2. **Public domain.** Connect `downloads.timds.com`; the timds.com zone must be
   on the same account. The bucket's `r2.dev` address stays disabled. If you
   choose another hostname, change `BINARY_DOWNLOAD_BASE` and the stock
   templates with it; the test in `src/binary-installation.test.mjs` names
   every place that must agree.

   ```bash
   cf r2 buckets domains custom create timds-downloads --domain downloads.timds.com --zone-id "$(cf zones list --name timds.com | jq -r '.[0].id')" --enabled --min-tls 1.2
   ```

3. **Credentials.** Create an account API token limited to item read and
   write on this one bucket, and store it as the repository's Actions secrets
   without printing it. R2's S3 access key ID is the token's ID and its
   secret access key is the SHA-256 of the token's value:

   ```bash
   (
   set -euo pipefail
   account="$(cf auth whoami | jq -r '.accounts[0].id')"
   read_group="$(cf accounts tokens permission-groups list | jq -r '.[] | select(.name == "Workers R2 Storage Bucket Item Read") | .id')"
   write_group="$(cf accounts tokens permission-groups list | jq -r '.[] | select(.name == "Workers R2 Storage Bucket Item Write") | .id')"
   policies="$(jq -nc --arg r "com.cloudflare.edge.r2.bucket.${account}_default_timds-downloads" --arg read "$read_group" --arg write "$write_group" '[{effect: "allow", resources: {($r): "*"}, permission_groups: [{id: $read}, {id: $write}]}]')"
   token="$(cf accounts tokens create --name "timds-toolkit release: timds-downloads upload" --policies "$policies")"
   printf '%s' "https://${account}.r2.cloudflarestorage.com" | gh secret set TIMDS_DOWNLOAD_ENDPOINT -R sticktrk/timds-toolkit
   printf '%s' "$token" | jq -jr '.id' | gh secret set TIMDS_DOWNLOAD_ACCESS_KEY_ID -R sticktrk/timds-toolkit
   printf '%s' "$token" | jq -jr '.value' | shasum -a 256 | cut -d' ' -f1 | tr -d '\n' | gh secret set TIMDS_DOWNLOAD_SECRET_ACCESS_KEY -R sticktrk/timds-toolkit
   gh secret list -R sticktrk/timds-toolkit | grep TIMDS_DOWNLOAD_
   )
   ```

   The release workflow reads `TIMDS_DOWNLOAD_ENDPOINT`,
   `TIMDS_DOWNLOAD_ACCESS_KEY_ID` and `TIMDS_DOWNLOAD_SECRET_ACCESS_KEY`.
   GitHub secrets cannot be read back, so step 4 needs credentials in your
   shell: either an R2 key that already covers every bucket (the
   `CLOUDFLARE_*` fallback below), or a second token made the same way with
   its three values exported under the `TIMDS_DOWNLOAD_*` names.
4. **Copy the existing releases.** Releases from 0.1.478 to the current one
   only exist on GitHub Releases. From a checkout with `gh` signed in and the
   `aws` CLI installed, export the three values from step 3 (the script also
   reads `CLOUDFLARE_S3_API_ENDPOINT`, `CLOUDFLARE_ACCESS_KEY` and
   `CLOUDFLARE_SECRET_ACCESS_KEY` from your shell if those already hold a
   token with access to the bucket), then:

   ```bash
   node scripts/binary-host.mjs mirror --all --dry-run
   ```

   ```bash
   node scripts/binary-host.mjs mirror --all
   ```

   The dry run downloads each release and checks its checksums and build
   records without writing anything. The real run uploads each one and
   verifies it at the public URL. About 0.5 GB per release; reruns skip what
   is already there.
5. **Spot-check** one download the way a client workflow does:

   ```bash
   curl -fsSLO https://downloads.timds.com/timds-cli/v0.1.492/SHA256SUMS && cat SHA256SUMS
   ```

6. **Merge and release.** The next release runs `host-binaries` for real.
   Binary-mode systems pick up the new download address in their managed
   workflows on their next `timds-cli upgrade --version EXACT_VERSION`;
   unmodified workflows are replaced by their recorded hash. A workflow from
   an earlier release keeps its GitHub address until it is upgraded.

## Before making this repository private

- Every binary-mode Design System and consumer repository has upgraded past
  the release that introduced this host (search for
  `timds-toolkit/releases/download` across the organizations that use TimDS).
- Run the release workflow with **dry run** checked after the switch:
  `check-trusted-publishing` shows npm still accepts the trusted publisher.
  npm creates no provenance attestation for a package published from a
  private repository; the publish itself still succeeds.
- Keep `repository.url` in `package.json`. npm's trusted publishing matches
  it against the publishing workflow's repository.
- Private repositories spend Actions minutes; macOS runners count at ten
  times the Linux rate, and `binary.yml` runs on macOS for every release.
