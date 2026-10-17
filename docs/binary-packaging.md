# Standalone executable packaging

The executable packages the existing TimDS implementation and integrated video
engine. Installation, exact workspace selection, adoption, upgrades, and
rollback are specified in [binary-installation.md](binary-installation.md).

## Decision and reproducible inputs

The selected runtime is **Node.js 24.22.0**, injected with
**postject 1.0.0-alpha.6**. `npm run binary:build` downloads the official native
Node distribution, checks a SHA-256 pinned in `scripts/binary-build.mjs`, and
uses that exact Node for both SEA preparation and the executable. Production
packages come from `npm ci --omit=dev` against the committed lockfile. The
package source is exactly the npm pack allowlist. npm, its CLI, and development
dependencies are not in the payload. Dependency license/notice files and Node's
complete LICENSE accompany the extracted runtime.

This is a small CommonJS SEA launcher containing compressed filesystem assets,
not a bundle of the application into the SEA module. It materializes the npm
package, production dependencies, and an unmodified general-purpose Node
interpreter, then runs `bin/timds.mjs`. That preserves ESM, dynamic imports,
package export conditions, TSX registration, native dependencies and runtime
filesystem discovery. The prototype demonstrated that stock viewer imports
resolve without a local `node_modules`. Bun was not needed to address a
remaining compatibility gap.

Node's [SEA documentation](https://nodejs.org/download/release/v24.22.0/docs/api/single-executable-applications.html)
describes builtin-only bootstrap imports, embedded assets, native addon
materialization, injection and signing. `useSnapshot` and `useCodeCache` are
both disabled. SEA command-line interpretation is disabled, and inherited
`NODE_OPTIONS` is removed before launching the packaged interpreter.

## Native targets

| Download suffix | Native validation runner | Runtime platform floor |
| --- | --- | --- |
| `darwin-arm64` | GitHub `macos-15`, Apple Silicon | macOS 13.5 or newer, on a vendor-supported release |
| `linux-x64` | GitHub `ubuntu-24.04`, x86-64 | Linux kernel 4.18+, glibc 2.28+, libstdc++ GLIBCXX 3.4.25+ |

The floors follow the [pinned Node build requirements](https://github.com/nodejs/node/blob/v24.22.0/BUILDING.md).
CI verifies its actual platform and architecture before building; no cross-built
executable is published. macOS x64, Linux arm64, musl/Alpine and Windows are
not advertised. Platform expansion requires a native build and the same smoke
suite. Linux browser rendering additionally requires Chrome's shared system
libraries, installed by the native job from [Remotion’s Ubuntu 24.04 prerequisites](https://www.remotion.dev/docs/miscellaneous/linux-dependencies). A browser download is separate from the executable and may need
network access on first rendering; see the video prerequisite documentation.

## Inventory and ownership boundary

| Surface | Existing implementation and resources | Packaged execution |
| --- | --- | --- |
| CLI and package identity | `bin/timds.mjs`, `src/core.mjs`, package metadata | Same modules; `src/executable.mjs` owns interpreter/CLI command construction and package location |
| Repository initialization and migration | `templates/`, `skills/`, `src/starter.mjs`, `src/upgrade.mjs` | Full npm allowlist materialized; no source assets copied from a development checkout |
| Brand, contract and MCP reads | `src/brand.mjs`, tokens/media/derived readers, `mcp*.mjs`, relative package metadata | Normal filesystem paths; MCP stdout remains JSON protocol only |
| Stock build/check/dev | Client starter scripts importing `@dtconcepts/timds/*` | Bundled Node plus ESM hook resolves the exact packaged module exports, outside client repositories |
| JavaScript workers | Draft checks, Remotion CLI, preview/producer workers | `javascriptCommand` uses the clean interpreter; `cliCommand` explicitly re-enters the SEA |
| TSX and React/Remotion | `tsx`, TypeScript, React, Remotion package exports; client visual overrides | Native Node dependency graph and ESM import conditions retained; video Webpack resolves runtime packages from the extracted package |
| Platform binaries | esbuild platform package, Remotion compositor and shipped FFmpeg tools | `npm ci` selects the native optional dependencies, all executable modes retained |
| Video assets | `video/` UI, components, rules, baselines, producer code, `templates/video/` | Included as real files; snapshot generation copies authored components only, never the engine |
| Browser downloads | Remotion Chromium/Chrome Headless Shell and consumer screenshots | Separate user browser cache; never part of the immutable runtime directory |
| Hosted drafts | `src/draft-source.mjs` and workspace child processes | Runtime location can cross a sanitized environment; portal credentials are never added back |
| Client-defined commands | Product build/dev/install commands and framework configuration | Retain their command semantics and prerequisites; missing custom tools produce actionable errors |
| Other external tools | Git/gh, browser openers, optional media/audio tools | Command-specific dependencies; no hidden package-manager bootstrap |

The package includes no client checkout, environment files, portal credentials,
production record, private URL or client media. `src/executable-loader.mjs`
forces toolkit imports to the selected packaged release; ordinary product
package resolution runs first for other dependencies. The ESM fallback uses
import conditions, rather than resolving import-only packages with CommonJS.

## Extraction, integrity and process behavior

The default cache is `~/Library/Caches/timds/runtime` on macOS and
`${XDG_CACHE_HOME:-~/.cache}/timds/runtime` on Linux. `TIMDS_BINARY_CACHE` can
select a different writable, private cache. It must be owned by the current
user. Each directory contains the package version, platform, architecture and
payload content hash. No runtime files are written into the client repository.

The executable embeds the manifest and its compressed payload hash. Each launch
checks every shipped file's SHA-256, size and executable mode against that
embedded manifest, verifies symlinks and their ancestors, and checks the
completion marker. Unexpected files are rejected because they could shadow Node
imports. A corrupted cache is reconstructed from the executable.
First extraction uses an exclusive initializer lock with dead-process recovery,
a unique temporary directory, complete validation, and an atomic rename.
Concurrent starters use the same completed cache. Interrupted temporary
extractions cannot be mistaken for completed runtimes. They may be removed
manually after no TimDS process is using the cache.

The launcher preserves working directory, argument boundaries, stdin/stdout/
stderr and child exit status. SIGINT, SIGTERM and SIGHUP forward to the child
process group, including stock viewer descendants. It emits diagnostics only
to stderr. `runtimeEnvironment(sanitizedEnv)` restores only runtime paths and their derived cache directory;
it never copies portal tokens or other parent variables into a filtered draft.

Extraction intentionally duplicates Node: the SEA is the installed launcher;
the clean cached interpreter runs ordinary JavaScript workers. Neither is an
external Node installation. This costs download/cache space but avoids treating
the CLI as `node`, which could recursively launch the CLI or break Remotion.

## Build, proof and checks

```sh
npm ci
npm test
npm run pack:check
npm run binary:build
npm run binary:smoke
npm run binary:smoke:video
```

A native Apple Silicon proof produced a roughly **223 MiB executable**, with a
**342 MiB extracted runtime** and approximately **15,400 files**. Exact byte
counts, payload hash, source commit/dirty state, manifest/lockfile hashes, platform, tool versions, and signing status are written
beside every build as `timds-cli-vVERSION-PLATFORM-ARCH.json`. The stock smoke
prints measured cold/concurrent and warm startup times instead of assuming a
performance budget. The Apple Silicon proof measured 5.3–6.1 seconds for two
concurrent cold launches and 0.77–0.84 seconds for a warm launch. Full cache verification is deliberately retained at warm
startup; startup cost includes hashing the production dependency graph.

`binary:smoke` copies the executable outside the checkout into a directory with
spaces, gives it a fresh HOME and a PATH containing only Git, and verifies that
Node/npm/npx/Bun cannot execute. It tests concurrent first launches, help/version,
stock initialization, build/check with exactly the two expected warnings, brand,
doctor, live dev/preview responses and termination, edit/read MCP protocol output,
mocked hosted authentication/start/submission and draft MCP, consumer installation,
corrupt/incomplete cache repair and nonzero exit forwarding. It invokes only the
moved executable for TimDS operations. `binary:smoke:video` extends that proof to
real rendering, client TSX overrides and the two-brand visual comparisons.
The ordinary suite also exercises extraction concurrency, dead initializer
recovery, traversal rejection, migration, pins, and sanitized environments.

PR CI and release CI run both native targets through these checks. A successful
local macOS proof is not Linux evidence: the Linux job must pass before the
release can publish. The binary pipeline gates npm publication, and both the
published-release event and the manual release path use the exact same release
commit. The attachment step checks the tag against package.json, checks both
platform identities, the clean source commit and manifest/lockfile hashes, and verifies executable hashes before creating SHA256SUMS.

## Signing

Local builds and unconfigured CI produce **ad-hoc signed macOS executables,
without notarization**; Linux executables are unsigned. SHA-256 verifies bytes
against the release manifest, not publisher identity. Do not describe an
ad-hoc signed download as Apple-notarized.

For Developer ID signing, configure release repository secrets
`TIMDS_MACOS_CERTIFICATE_BASE64`, `TIMDS_MACOS_CERTIFICATE_PASSWORD` and
`TIMDS_CODESIGN_IDENTITY`. The release-only reusable workflow imports the
certificate into a temporary keychain, signs with the JIT entitlements in
`scripts/binary-entitlements.plist`, and removes the keychain afterwards.
Optional `TIMDS_NOTARY_APPLE_ID`, `TIMDS_NOTARY_TEAM_ID` and
`TIMDS_NOTARY_PASSWORD` enable notarization and wait for Apple's result before
smoke tests and upload. Command-line Mach-O executables have no stapled ticket;
Gatekeeper retrieves the notarization record online. Signing/notarization changes
are reflected in the build JSON. PR checks receive no release signing secrets.
