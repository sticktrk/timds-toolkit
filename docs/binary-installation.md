# Standalone installation contract

`timds-cli` is a second distribution of the same `@dtconcepts/timds` release.
The npm distribution keeps its bounded `0.1.x` requirement and exact lockfile.
A binary installation records this independent, exact selection:

```json
{
  "schemaVersion": 2,
  "mode": "binary",
  "name": "@dtconcepts/timds",
  "version": "<exact package version>",
  "executable": "timds-cli"
}
```

The record remains `.timds/installation.json`, beside `timds.json` for a
Design System or at the product root for a consumer. Existing managed-file
hashes, automation ownership and consumer metadata remain in that record.
No machine-local executable/cache path is committed. The executable reports
its own version with `--version`; `doctor` also reports the selected version.
Commands refuse a different selected release before editing workspace files.

A fresh binary `init` selects the running release. Existing npm workspaces
require `timds-cli installation adopt --binary` to preview the migration,
then `--apply` to apply it. For a stock system this explicitly changes the
three `timds.json` workspace commands to `timds-cli run scripts/NAME.mjs` and
renders managed skills/automation for binary execution. This is a contract
migration, not ordinary upgrade permission. Customized commands remain as
written and require their declared tools; missing tools fail with an explicit
diagnostic. Package manifests, lockfiles, authored documentation, content,
consumer pins and product source are retained. Managed file changes follow
the existing hash/force boundary. Starter synchronization retains its own
file-specific force, clean-tree and rollback rules.

`timds-cli run FILE [ARGS...]` runs JavaScript with the embedded Node runtime
and resolves TimDS imports from the external runtime cache. It neither
installs dependencies nor interprets arbitrary npm scripts. Custom product
builds continue using the product's declared toolchain.

Replacing an executable and selecting a workspace release are separate:
install a versioned download, verify its published SHA-256 checksum, and
replace the executable with a same-filesystem atomic rename while retaining
the previous executable for rollback. Then invoke that release's
`timds-cli upgrade --version EXACT_VERSION` to select it and synchronize the
managed files. A plain `upgrade` only synchronizes the already selected
release. There is no implicit self-update or resolution of `latest`.
Rollback uses the retained executable and an explicit upgrade to its exact
version; review the managed diff just as for an upgrade. Restore the prior
workspace commit when authored migration changes also need rolling back.

Consumer adoption changes only its managed skills, workflows, TimDS launch
and MCP entries, and installation record. Existing npm hooks remain for
products using npm; a binary-only consumer explicitly runs
`timds-cli consumer sync` to install its selected published bundle. Ordinary
upgrade never changes the Design System pin or product commands.

The downloadable platform matrix, build/runtime pins, cache behavior,
prerequisites and actual signing status are documented in
[binary-packaging.md](binary-packaging.md). Release CI must test the npm
package and native binaries from the same commit before distribution.

## Download and install

Choose an exact released version from the
[release downloads](https://github.com/sticktrk/timds-toolkit/releases). The
initial supported downloads are macOS Apple Silicon (`darwin-arm64`) and
Linux x86-64 with glibc (`linux-x64`). No package-manager command is needed:

```sh
(
set -eu
VERSION=0.1.RELEASE_NUMBER # replace with the exact release you selected
TARGET=darwin-arm64       # or linux-x64
ASSET="timds-cli-v${VERSION}-${TARGET}"
BASE="https://github.com/sticktrk/timds-toolkit/releases/download/v${VERSION}"
curl --fail --location "$BASE/$ASSET" -o "$ASSET"
curl --fail --location "$BASE/$ASSET.sha256" -o "$ASSET.sha256"
shasum -a 256 --check "$ASSET.sha256" # Linux can use sha256sum --check
if [ "$TARGET" = darwin-arm64 ]; then
  codesign --verify --strict --verbose=2 "$ASSET"
  codesign --display --verbose=4 "$ASSET"
  codesign -vvvv -R='notarized' --check-notarization "$ASSET"
fi
chmod +x "$ASSET"
./"$ASSET" --version
mkdir -p "$HOME/.local/bin"
cp "$ASSET" "$HOME/.local/bin/timds-cli.new"
# Keep an existing executable for an explicit rollback.
if [ -f "$HOME/.local/bin/timds-cli" ]; then
  cp "$HOME/.local/bin/timds-cli" "$HOME/.local/bin/timds-cli.previous"
fi
mv "$HOME/.local/bin/timds-cli.new" "$HOME/.local/bin/timds-cli"
timds_cli_path="$HOME/.local/bin/timds-cli"
"$timds_cli_path" --version
)
export PATH="$HOME/.local/bin:$PATH"
```

Continue only after checksum verification succeeds. Save the PATH line in your
shell profile for later sessions. The final rename is on the destination
filesystem, so readers see either the previous executable or the complete new
one. Running workspaces keep their selected release until an explicit upgrade.
To restore the executable, copy `timds-cli.previous` to `timds-cli.new` and rename
it over `timds-cli`, then select the matching version in the workspace or restore
its reviewed prior commit. Downloads are never executed by a curl-to-shell pipe.

On macOS, check the release's adjacent build JSON for Developer ID signing and
accepted notarization of both the launcher and its extracted native runtime.
The raw CLI has no stapled ticket, so keep the Mac online for first use. The
install snippet verifies its signature and online notarization record before
execution. The signature display should identify the release publisher's Developer ID
Application team and a timestamp; an ad-hoc signature is not equivalent. Apple
publishes notarization records online, as described in its
[notarization overview](https://developer.apple.com/documentation/security/notarizing-macos-software-before-distribution).
Do not remove quarantine or disable Gatekeeper to install a rejected release.
Report the exact release, macOS version, and diagnostic output instead. The
[release validation procedure](binary-packaging.md#validate-a-notarized-release)
covers a quarantined Safari download and the extracted native files; checksums
and a successful launch alone do not establish that full proof.

A fresh system can be created with:

```sh
mkdir my-system
cd my-system
git init -b main # omit for --provider hosted
timds-cli init --standalone --name "My system"
timds-cli check
timds-cli brand
timds-cli dev
```

A hosted system uses `timds-cli auth login`, then `timds-cli start SYSTEM --root
FOLDER`. A source snapshot still selecting npm needs the explicit adoption
command above before ordinary binary execution. Stock drafts loaded by the
read MCP server use the embedded runtime after verifying their stock script
bytes; custom draft commands need their declared build toolchain. Credentials
are filtered before any draft script runs.

Git and GitHub CLI are needed only for commands that use those services. Browser
rendering may download Chrome into a separate user cache and needs the platform's
browser libraries. Python/FFmpeg and other media utilities are required only by
the operations that name them. Consumer/product build commands retain their own
Node, npm, Bun, framework or other requirements. Binary `--dependency-prs` is
not supported: that opt-in workflow manages npm dependencies. Remove that
workflow and its recorded ownership in a reviewed change before adopting binary
mode; binary version selection is explicit.
