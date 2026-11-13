# Executable download host

Clients download the `timds-cli` executables from a public Cloudflare R2
bucket behind `https://downloads.timds.com/timds-cli/`
(`BINARY_DOWNLOAD_BASE` in `src/binary-installation.mjs`). Stock workflows
and installation instructions use that stable public address. GitHub Releases
also receive the executables as release records. This is distribution of the
public toolkit, separate from operating a TimDS Cloud host.

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

`release.yml` publishes to npm first, then builds and verifies the native
executables, including signing and notarizing the macOS build. Once both builds
pass, `host-binaries` verifies the release (`scripts/binary-release.mjs`) and
uploads it with `node scripts/binary-host.mjs upload <version>`. In parallel,
`attach-binaries` attaches the executables to the GitHub Release. The npm version
can be available while the executable builds or public download upload are pending.

## Release configuration

The release workflow uses the `aws` CLI with these Actions secrets. Keep the
credentials outside source and restrict them to the download bucket:

| Setting | Purpose |
| --- | --- |
| `TIMDS_DOWNLOAD_ENDPOINT` | R2 S3 endpoint |
| `TIMDS_DOWNLOAD_ACCESS_KEY_ID` | S3 access key ID |
| `TIMDS_DOWNLOAD_SECRET_ACCESS_KEY` | S3 secret access key |
| `TIMDS_DOWNLOAD_BUCKET` | Optional repository variable; defaults to `timds-downloads` |

The bucket serves `downloads.timds.com`. If that hostname changes, update
`BINARY_DOWNLOAD_BASE` and the stock templates together;
`src/binary-installation.test.mjs` checks their agreement. Already-adopted
workflows receive new stock bytes on the next explicit toolkit upgrade,
subject to their recorded hashes and customization policy.

For local maintenance, `scripts/binary-host.mjs` reads the same environment
variables, with `CLOUDFLARE_S3_API_ENDPOINT`, `CLOUDFLARE_ACCESS_KEY` and
`CLOUDFLARE_SECRET_ACCESS_KEY` as fallbacks. It does not read `.env`.

## Agent commands and verification

The normal release workflow performs uploads. To inspect a prepared release
without uploading it, run this from the toolkit checkout:

```bash
node scripts/binary-host.mjs upload EXACT_VERSION --dir dist/binary --dry-run
```

`EXACT_VERSION` is the package version, optionally prefixed with `v`. The
directory must contain both native executables, each build JSON and `.sha256`,
and `SHA256SUMS`. The dry run checks those local bytes and build records and
lists their destination URLs; it does not check credentials, existing remote
objects or public availability. Omit `--dry-run` only when publishing those
verified bytes is the intended operation.

To inspect or restore copies of releases already attached to GitHub, use
`mirror` from a checkout with `gh` authenticated:

```bash
node scripts/binary-host.mjs mirror EXACT_VERSION --dry-run
node scripts/binary-host.mjs mirror --all --dry-run
```

The dry run downloads the selected releases into temporary directories and
validates their checksums and build records. Omitting `--dry-run` also needs
the upload credentials and `aws`; it uploads missing objects, refuses any
different bytes under an existing key, and verifies all files through their
public URLs. `--all` selects GitHub releases that carry executable assets;
it does not assume every older npm release has a binary. Repeating an upload
or mirror safely skips identical stored bytes.

A successful checksum/build check alone does not prove publication. Upload
success includes public read-back of every file. A storage conflict requires
investigating the release identity and bytes; do not overwrite a released key.
For installation and macOS trust checks, use
[binary installation](binary-installation.md#download-and-install) and
[notarized release validation](binary-packaging.md#validate-a-notarized-release).
