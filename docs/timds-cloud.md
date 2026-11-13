# TimDS Cloud

The hosted layer of TimDS: sign-in, hosted editing sessions, Studio review,
publication, hosted media storage, consumer registration, notes, previews and
drafts, and hosted MCP. The toolkit reaches a host only through its public API
(`@dtconcepts/timds/hosted` and the clients beside it); running a host is
documented in the host repository. Everything in the main
[README](../README.md) works without a host.

## Getting started with a hosted system

Use the host URL supplied by your Studio installation. An agent signs in
once, then starts an editing workspace with the current hosted CLI:

```sh
npx --yes @dtconcepts/timds@latest auth login --portal-url https://YOUR-HOST --oauth
npx --yes @dtconcepts/timds@latest start example/core --root ./core
cd core
npm ci
npx --yes @dtconcepts/timds@latest doctor --json
npx --yes @dtconcepts/timds@latest dev
# After editing:
npx --yes @dtconcepts/timds@latest check
npx --yes @dtconcepts/timds@latest submit --note "Describe the change" --json
```

If the workspace has no lockfile, use `npm install` instead of `npm ci`.
Below, `timds` is shorthand for that hosted invocation. In a local/Git npm
client use its selected `npm run timds --` command. For binary mode use the
verified `timds-cli` release selected in `.timds/installation.json`; adopting
an npm source snapshot requires the explicit
[binary migration](binary-installation.md), and binary version changes are
never implicit. Designers direct the agent rather than running these steps.
Login reuses an existing credential (refreshing OAuth when needed); use
`--force` to authorize again or switch accounts. The last successful login
remembers the host outside your repository, so `start` needs no repeated portal
flag. An older credential file with exactly one signed-in portal also works;
multiple portals without a saved selection require `--portal-url` or
`TIMDS_PORTAL_URL`. Explicit flags and workspace configuration take precedence.
Hosted `doctor` checks the contract without requiring Git; `doctor --json`
prints the same facts as one JSON object. If the local dev
port is busy, use `timds dev --port 4322`; this supplies `PORT` to the workspace's
dev command. Frameworks that do not read `PORT` need their own port configuration.
For a static review, use `timds preview --port 4401`.

### Give your agent the skills

Designers work through Studio and an AI agent (Claude Code, Codex, Cursor,
Gemini CLI) that runs this CLI for them. Install the skills that teach the
agent the workflow once, in the folder the agent works from:

```sh
npx --yes @dtconcepts/timds@latest skills install --portal-url https://YOUR-HOST --system-id example/core
```

This writes the designer skills (`timds-edit-design-system`, `design-start`,
`design-media`, `design-ship`, `design-handoff`) and, for the named system,
the hosted skill (`timds-<system>`, rendered from
`skills/timds-hosted-design-system/` with the host, system and Studio link
filled in) into `.agents/skills/`, `.claude/skills/` and `.cursor/skills/`.
Then tell the agent what to change. Without `--portal-url` and
`--system-id` only the system-independent skills are installed.
A designer who works on several systems runs the command once per system:
the designer skills are shared and each system gets its own `timds-<system>`
skill, and `timds systems` lists the ids to use.
Installed skills are files and do not update themselves, while the CLI
always runs at `@latest`: the hosted skill has the agent rerun the install at
the start of each conversation, and every hosted command prints one line
after its output when the nearest `.timds/skills.json` (this folder, its
parents, then the home folder) was written by an older release.
`--global` installs under the home folder instead; `--system-name` and
`--studio-url` override the names the skill shows. A folder that is a link
to another of the three is written once.

Every written file's digest is recorded in `.timds/skills.json` (with
`--global`, in `skills.json` beside the TimDS credentials file). Rerun the
same command at `@latest` to refresh: unmodified files are replaced, systems
installed earlier are rendered again without their flags, files a release no
longer ships are removed, and a file someone edited is kept and reported
unless `--force`. The command refuses to run in a Design System repository
or a consumer repository, whose skills `init`, `consumer init` and
`upgrade` manage, and in a hosted session workspace, where the files would
be submitted with the system.

Repository skills managed by `upgrade` have separate policies and hashes.

## Hosted design sessions

A `provider` setting in `timds.json` selects the workflow. `{ "kind": "local" }`
keeps authoring on disk; `{ "kind": "git" }` keeps the existing branch and pull
request submission; `{ "kind": "hosted", "url": "https://timds.com" }` uses the
host API. Existing manifests without a provider keep their git submission
behavior. Hosted commands without a configured or saved host fail with the
sign-in command and `--portal-url` remedy; they never fall back to git.

Humans direct work and use five verbs: `login`, `status`, `history`, `publish`,
and `rollback`. Agents write with the CLI commands below, which the hosted
skill (`timds skills install`) teaches them. The MCP tools `timds_start`,
`timds_pull`, `timds_submit`, `timds_update`, `timds_sessions_close`,
`timds_claim`, `timds_active_work`, `timds_join`, `timds_whoami`,
`timds_systems`, `timds_principals`, and `timds_draft_create|list|close` expose the same
operations for hosts and MCP clients, beside `timds_status`,
`timds_history`, and `timds_publish` for the human verbs.

`timds auth login` (also `timds login`) selects `--portal-url` first, then the
nearest workspace's host (its open session's, else `timds.json` `provider.url`),
then `TIMDS_PORTAL_URL`, then the
saved selected login, and finally `https://timds.com`. Status and logout
select the same host. When several saved logins have no selected host, supply
`--portal-url` to avoid that default.
A host advertising
`/.well-known/oauth-authorization-server` uses authorization code with PKCE S256
and a temporary `127.0.0.1` callback. The CLI registers a public client when the
host permits it; otherwise supply its registered `--client-id`. It requests the
host's advertised `timds:read`, `timds:write` and `offline_access` scopes for
`<host-origin>/api/timds`; publication still requires a publisher grant.

Interactive login opens the browser and always prints the authorization URL.
Use `--no-browser` to open that URL yourself on the same machine; a remote shell
needs loopback port forwarding or `--device` on a portal supporting device login.
`--oauth` requires OAuth discovery; `--device` explicitly keeps the portal flow.
Automatic fallback uses device login only when discovery is unavailable with
HTTP 404, 405 or 501. Invalid metadata or a failed OAuth request never switches
flows. OAuth requires HTTPS except for local loopback development hosts.
Use `--timeout-seconds N` for the OAuth wait (default 600, maximum 3600), or
Ctrl-C to cancel.

Credentials remain outside the repository in the owner-only TimDS credentials
file, keyed by host origin. OAuth refresh tokens rotate when saved access tokens
near expiry. Concurrent CLI and MCP processes serialize refresh, login and logout
with a credentials-file lock, reload after locking, and atomically replace the
file. A crashed owner's lock expires; waiting for a live owner is bounded.
No token, code verifier or refresh token is printed. `auth logout`
removes the local credential; it does not revoke the host-side authorization.
`--token` and `TIMDS_ACCESS_TOKEN` retain the existing explicit-token paths.
Hosted commands reload the credential before each request. After an HTTP 401,
they retry the exact serialized request once only if the locked OAuth refresh
or another process supplies a different access token; explicit tokens are not
refreshed. Other authentication or permission failures remain errors.

```sh
# Human controls
timds login --portal-url https://timds.com
timds status
timds history
timds publish --dry-run
timds publish --yes
timds rollback 1.2.3 --dry-run
timds rollback 1.2.3 --yes

# Agent operations
timds draft create spring-refresh --from main --system-id example/core
timds start example/core --draft spring-refresh --on 'tokens/color*' --root ./session
timds active-work
timds claim --on 'tokens/color*' --note 'Warm the brand palette'
timds pull
timds submit --note 'Warm the brand palette'
timds update --resolve 'tokens/color.json#brand.value=theirs' --note 'Keep the director’s color'
timds sessions close
timds whoami
timds systems
timds principals
timds join SESSION --principal-id PRINCIPAL
timds join SESSION --root ./member-session
timds join "https://YOUR-HOST/studio/#source=SOURCE&view=studio&session=SESSION&join=1"
timds draft list
timds draft close spring-refresh
```

Publication waits for the host's final result, including automatic retries
while session cleanup is `closing`. A cleanup error records the latest attempt
and does not end polling early. The wait is bounded to 30 minutes; if cleanup
remains pending, the CLI reports that the publication committed and gives the
same-submission command to resume waiting without creating another publication.

`start` requires an empty agent workspace and materializes plain files without
a `.git` directory. Interrupted starts retain their idempotency key under
`.timds/start.json`; retry the same command, or use its key in a fresh empty
workspace after a partial download. Credentials remain in the private TimDS
credential file or `TIMDS_ACCESS_TOKEN`, never source or session metadata.
`TIMDS_PORTAL_URL` selects a host before a session exists. Inside a session the
host recorded in `.timds/session.json` wins over `timds.json` `provider.url`,
which is source content and can name an origin the host has since left; a
flag or `TIMDS_PORTAL_URL` naming another host is refused.
With that host configured, `timds mcp --root PATH` keeps an empty, missing, or
interrupted destination at the exact requested path, even within another
repository. Start or join the session there before using editing tools; its
ancestor's files and session are outside that MCP workspace.

Hosted `update` and `submit` recover HTTP 502/524 timeouts and explicit session
operation-busy responses by resending the identical serialized change set, up
to six attempts within five minutes. This allows the host to return a completed
operation's receipt without duplicating its changes. CLI and MCP share this
behavior. Key conflicts, stale revisions, publication conflicts, and other
commands are not transport retries; they retain their normal resolution flow.

Claims are advisory: overlapping work is visible, never blocked. `status` and
`active-work` expose members, claims, submissions and live URLs. An owner or
publisher invites a principal with `join --principal-id`; an invited principal
attaches to the same fork with `join`. `whoami` prints the signed-in
principal's id, name and type for the selected host, `systems` lists every
Design System that principal can see there with its id, so an agent can move
between systems, and `principals` lists the people and agents who can be
invited into the Design System's sessions.
`join` materializes the session into an empty `--root`, selects the host the
same way `start` does, and prints the workspace and next steps; it refuses a
folder that already has files or another session and names `--root
./NEW-FOLDER` as the fix. `join` also accepts the Studio invite link in place
of the session id: the link's origin selects the host unless `--portal-url`
does, the CLI signs in to that host first when this machine has no credential
for it, and without `--root` the session lands in a new `./session-<first 8
characters of the id>` folder instead of the current one. A member sends work
to the shared session with `update` and freezes it for review with `submit`. Agent principals must supply the human
intent as `note` on every update and submission; history retains it and the
acting principal. Drafts are named sessions with no expiry. A session started
with `--draft` targets that draft; publishing its head uses the normal main
publication path.

Each change set carries `baseRevision` and `lastUpdateHash`. A stale shared
fork response preserves the agent’s changes and returns current files,
`stale:true`, and key conflicts. When the host returns `rebasedChanges`, the
client adopts the current baseline, reapplies that patch and retries once.
Further changes require another explicit call. Conflicts have
`{path,key?,base,mine,theirs}`. `update --resolve PATH` retains the local file;
`--resolve PATH#KEY=mine|theirs` resolves only that key. The host verifies
`mainRevision` so a resolution cannot silently overwrite newer work.

Hosted `submit` freezes a submission and preview; it does not open a pull
request. `publish` selects the latest submission unless `--submission` is
provided, rechecks current main and the publisher grant, and requires
confirmation (`--yes` for automation). `--dry-run` reports conflicts and
checks without publishing. `rollback VERSION` also requires a publisher
and confirmation. Humans can do all of this in Studio. Successful publication
closes the session. Set `TIMDS_PORTAL_URL` to start `timds mcp` in an empty
agent workspace; the tools share this CLI implementation.

### Native live preview updates

Hosted live previews restart the dev server on source changes by default.
A system whose dev server already watches and recompiles its authored inputs
can explicitly opt into native hot module replacement in `timds.json`:

```json
{
  "live": {
    "strategy": "hmr",
    "restartOn": ["astro.config.mjs", "scripts/contract-tokens.mjs"]
  }
}
```

`live` is a top-level preview contract, separate from the argv commands in
`workspace`. Missing or null `live` keeps the default full restart behavior.
The only supported strategy is `hmr`. `restartOn` is a required array of up to
100 exact paths relative to the Design System root; duplicates are removed.
Each path must be 1–500 characters with forward slashes, without absolute
paths, traversal, empty segments, control characters, colons, or glob syntax.
An empty array is allowed. Hosts still restart on manifest, dependency, and
framework configuration changes; declarations add paths such as custom
compiler scripts to that mandatory set. Paths are data, never shell commands.

The system must provide working watchers for token groups and other generated
inputs before opting in. For example, a compiler that runs only during Astro
configuration will not respond to later token edits; it needs a dev watcher
that regenerates the imported stylesheet. Hosts may support this optional
contract independently; the CLI's local `dev` command keeps running the
declared `workspace.dev` command. Checks and upgrades preserve the authored
manifest, and release preparation changes only its version.

## Hosted media upload

Stage a file with `assets add` as the [README](../README.md#large-public-images-video-audio-and-b-roll) describes. Authenticate
once through the operator portal, then upload changed staged files:

```bash
npm run timds -- auth login
npm run timds -- assets publish
```

Git-provider `submit` also publishes staged media before it builds and opens
the pull request. Hosted `submit` sends the session change set and freezes a
submission; publish staged assets explicitly before submitting it. Only the
stable key, checksum, metadata, and public CDN URL enter the media catalog
(`media/*.json` with a generated `media.json` view on grouped systems).
Timed media is inspected with `ffprobe` during `assets add`, so
video and audio records also carry their measured duration; video records carry
dimensions, frame rate, and codec when available. The raw file and
`.timds/local-media.json` remain ignored.
Staging records the current catalog checksum locally. Publishing (including
`submit`) checks every staged entry before uploading and refuses replacements
if the catalog has changed since staging. Older staging entries without a
baseline may still publish new keys or match unchanged records, but cannot
replace existing records until deliberately restaged. To keep the published
asset, remove its stale entry from `.timds/local-media.json` or restore it with
`assets pull KEY --force`. Run `assets add FILE --key KEY` again only after
reviewing the intended replacement; do not restage an original over an
optimized derivative just to clear a conflict. Successful publication advances
the local baseline, so reverting `media.json` does not replay the old upload.
If storage returns an asset ID already registered under another logical key,
publication refuses that catalog write and preserves both keys. Use the
existing key instead of implicitly renaming it.

If an object transfer fails, the CLI reports the bounded storage response and
cancels the server upload lease before returning the error, so correcting the
problem and rerunning `assets publish` does not wait for a stale lock to expire.
`TIMDS_ACCESS_TOKEN` can be used for non-interactive CI or agent sessions.

Catalogs created before timed metadata was supported can be repaired in place
from their stable public URLs without re-uploading the objects:

```bash
npm run timds -- assets backfill-metadata
```

Both commands require `ffprobe` from FFmpeg on the workstation. Set
`FFPROBE_PATH` only when it is installed outside the normal command path.

To restore a published asset into a fresh local workspace:

```bash
npm run timds -- assets pull founder-interview
```

## Publish the portal release

After the source commit reaches the connected repository's source branch, an
operator can release its exact build:

```bash
npm run timds -- auth login
npm run timds -- publish
```

`publish` builds and checks, pushes `artifact.publishRef`, then calls
`POST /api/timds/publish` with the local version, source commit and content digest.
The ref push is refused unless the checkout commit is the remote default-branch
head, since the portal only promotes that commit and the push replaces the live ref.
The artifact ref must differ from the remote default branch; publication refuses
to push if that branch name cannot be resolved.
It needs an unbound operator CLI token; set `TIMDS_ACCESS_TOKEN` in CI. Client-bound
designer/website tokens and consumer read credentials cannot promote releases.
The command never changes the source version or enables automatic updates.

With **Automatic updates** on for the system, the response names its public root
and pinned release URLs. The command verifies the current root's
`.timds-artifact.json` before succeeding. With the setting off it succeeds with
an `awaiting-operator` candidate, prints the portal action and leaves the root
unchanged. Publishing an already live identical stamp is a successful no-op.
`--json` prints the result for automation; returned bundle URLs require the system
to supply a consumer bundle.

The local stamp lives at `.timds/cache/.timds-artifact.json`, outside `dist/`,
and is written only after the ref push succeeds. Its SHA-256 covers the normalized
publication snapshot (artifact file paths, byte counts and hashes, source assets,
documents, components, public manifest, media and authored tokens); build times
and repository IDs do not participate. Source contract files must be committed;
their bytes are hashed from the commit's blobs, so checkout line-ending or LFS
filters cannot change the digest, and every file in `dist/` is pushed even when a
Git ignore rule matches it.
Stale local stamps, mismatched remote candidates and unavailable public bytes
fail the command. After a successful ref push, retry promotion without changing
the build using `npm run timds -- publish --skip-build --skip-push`.

Managed standalone release workflows finish CDN extraction, push the exact
artifact, and then run that promotion command as their final publication step.
They require an operator `TIMDS_ACCESS_TOKEN`; a missing secret fails the run
before the version advances, and `upgrade` says so when it refreshes the workflow.
`extract --publish` remains the separate CDN upload operation. Adopt older stock
automation with `upgrade --auto-release`; ordinary upgrades refresh already
adopted stock files and refuse customized workflows unless replacement is forced.

## Consumers on a host

### Hosted follower updates

A product with a fixed published release pin can register with a TimDS host:

```sh
npm run timds -- consumer register --portal-url https://host.example.com
npm run timds -- consumer updates --portal-url https://host.example.com
npm run timds -- consumer updates 2026.10.27-2 --portal-url https://host.example.com --json
```

Registration requires `timds.consumer.json` at the Git repository root; a
manifest found only in a subdirectory is refused before contacting the host.
A site inside its Design System's workspace (`designSystem.workspace`) is
refused by `register` and `updates`: it follows its system in the same
change, so there is nothing for a host to follow.
It reads that manifest, resolves its system ID in the
signed-in host's catalogue, discovers the GitHub repository from `origin`, and
posts one source-scoped follower. It prints the signed GitHub App installation
link; complete that installation to activate updates. The existing TimDS
OAuth login supplies the credential, only to the selected host. GitHub App
keys and installation tokens stay on the host. The optional `--portal-url`
selects the host before `TIMDS_PORTAL_URL`, then the saved selected login.
When no saved host is unambiguous, provide `--portal-url`; the CLI does not
guess between accounts.

The default policy runs a hosted agent and opens a pull request for developer
review. `--delivery approve` asks a publisher in Studio to approve the
prepared change before delivery. `--notify` instead sends the repository
release notification for an existing Actions workflow. `--repository
OWNER/REPO` and `--base-branch REF` select those values explicitly. Hosted
runs require the product's pinned CLI to support
`consumer check --allow-pin-update LABEL`; update older product lockfiles
through their reviewed dependency workflow before enabling the hosted agent.

The registry's upper bound is the safe directory prefix of each app's design
surface, plus the pin manifest. The runtime also enforces the immutable base
manifest's complete globs and protected paths. A root glob such as `*.css`
has no safe prefix; provide explicit `--surface PATH` values instead of
silently widening it to the repository root. Registration never edits the
product manifest, dependency lock or workflow. The registration allows at most
100 distinct prefixes, including `timds.consumer.json`; the CLI checks this
bound before posting.

A stable registration UUID and its original request live under
`git rev-parse --git-common-dir` in `timds-consumers/`, outside the tracked
product. The first request is saved before transport; a lost response or
another invocation reuses it. The record contains no token or installation
secret. A later local pin move does not create another follower. Manage an
existing follower's state in Studio. A rerun must use the same update mode:
repeat `--notify` for a notification follower and omit it for a hosted one.
Changing mode in either direction, explicit delivery policy or a supplied
surface refuses rather than registering a duplicate.

`consumer updates` reads retained run receipts; add a label for the newest
attempt at that label, or `--consumer-id UUID` from another checkout. Receipt
labels follow the host contract: at most 100 characters, starting with a letter
or digit and continuing with letters, digits, `.`, `_`, `+` or `-`. Its JSON
is the same source-scoped receipt Studio and authenticated MCP read, including
rollback status, safe failure or skip reason, and the pull request URL. The
host never merges or deploys the product.

### Designer notes and CI previews

- `timds consumer notes [--app NAME] [--pull-request N] [--all] [--json]`
  lists the notes a designer left on the pull request's preview in the portal,
  grouped by page, with the element, its source `file:line` when the dev build
  stamps one, and the designer's words. `timds consumer notes resolve ID...
  [--commit SHA] [--dismiss]` marks them addressed (or dismissed) after the fix
  is pushed. Both need `TIMDS_ACCESS_TOKEN` or `timds login`.

Automatic consumer previews are **off by default**. To enable
`.github/workflows/timds-consumer-preview.yml`, set the repository variable
`TIMDS_PREVIEWS_ENABLED` to `true` and configure the `TIMDS_ACCESS_TOKEN`
repository secret. For a private submodule pin, also configure
`DESIGN_SYSTEM_DEPLOY_KEY` (a read-only deploy key) or
`TIMDS_CONSUMER_SUBMODULE_TOKEN` (with `contents:read`) so CI can check out
that submodule. Published pins do not need a submodule credential.
An unset or false variable
skips all preview jobs without allocating a runner. With the variable enabled
but no publishing token, only a short token-presence job runs; checkout,
installation, validation, rendering, artifact upload, and comments are skipped.
There is no artifact-only preview fallback. Product build, test, and smoke
workflows remain independent, and `consumer check` and local
`consumer preview --app NAME` still work without enabling CI previews.
When previews are disabled, review locally and include the review URL,
screenshots, and routes in the draft pull request.

### Consumer drafts

A published consumer can opt in with `timds consumer init --draft-preview`.
It writes `.timds/draft-preview.mjs`; a root HTML entry gains the module after
its pinned stylesheet, while framework applications import the module from
the browser entry. `?timds_draft=spring-refresh` appends the draft’s public
`tokens.css`; without the query the pinned stylesheet is unchanged. For a
preview hostname, call `installDraftPreview` from
`@dtconcepts/timds/consumer-draft-preview` with `hostnameDrafts:{hostname:name}`.

`timds consumer update --draft spring-refresh --portal-url https://timds.com`
fetches an authenticated snapshot, checks an isolated local build and installs
its digest-verified bundle into the ignored consumer directory. It leaves the
tracked production version pin untouched. `consumer check` identifies the
local draft override; `consumer sync` restores the exact published pin. A
workspace site has no pin to override and refuses `--draft`; check out the
draft's branch of the workspace instead. A hosted session of a system with a
workspace site carries the site's source and never its dependencies, build
output, local state or secrets.

`timds mcp read --draft spring-refresh --system-id example/core --portal-url
https://timds.com` serves the checked draft’s derived layer; every read refreshes
its snapshot and rebuilds only when its revision changed. Hosts registering
read tools receive optional `draft` alongside `systemId` and `version` in their
resolver. Report missing guidance through `report_gap`.

Local hosted editing MCP commands return snapshot file paths and counts, session
revisions, and exact conflicts. They do not echo binary snapshot contents through
stdio. `filesMaterialized` identifies a successfully applied snapshot; use the
editing `read_file` tool for authored local files. A conflict leaves local files
unchanged and can be resolved with `timds_update`. The version-1 host HTTP
snapshot API continues to transfer full file contents.

## Hosted sources and offshoots

For a new hosted source scaffold use `timds init --standalone --provider hosted
--portal-url https://timds.com`. This writes local source; it does not provision
a remote Design System, register it or publish it. It emits `wrangler.jsonc`
with top-level `assets.directory: "./dist"`, an empty `previews` block,
Wrangler `^4.135.0` as an npm development dependency (omitted in binary mode),
and a root `_headers` file copied into `dist/`
with `X-Robots-Tag: noindex`. It emits no GitHub workflows. Local and git
scaffolds keep their existing automation. `publish --skip-build --skip-push`
remains available to the host's publication path.

The host's runner feeds an offshoot's session workspace with `timds feed --source-file` (and, for a child
shot before stock hashes, `--baseline-file`) and `--json`. Hosted change sets omit the generated `tokens.json` and `media.json` views, so
independent group changes do not create aggregate-file conflicts.

## Session API version 1

The public provider interface is exported from `@dtconcepts/timds/hosted`:
`createHostProvider` supplies sessions (`start`, `pull`, `submit`, `update`,
`status`, `history`, `close`, `claim`, `join`), identity/system discovery,
drafts, publication, rollback, release-source reads and consumer registration
and receipts. API
version 1 uses the following relative endpoints with a TimDS Bearer token
and `X-TimDS-API-Version: 1`:

| Method | Path | Request |
| --- | --- | --- |
| POST | `/api/timds/sessions` | `{apiVersion:1, systemId}` |
| GET | `/api/timds/sessions/:id` | Snapshot of the session fork |
| POST | `/api/timds/sessions/:id/submit` | Change set |
| POST | `/api/timds/sessions/:id/update` | Change set, optional `resolvedPaths` and `mainRevision` |
| GET | `/api/timds/sessions/:id/status` | Session and latest submission |
| GET | `/api/timds/sessions/:id/history` | Commits and publication events |
| POST | `/api/timds/sessions/:id/join` | `{principalId?}`; invite or attach |
| POST | `/api/timds/sessions/:id/claims` | `{patterns,note?}` |
| GET | `/api/timds/design-systems/:id/active-work` | Members, claims, submissions and live URLs |
| GET | `/api/timds/design-systems/:id/principals` | People and agents who can be invited |
| GET | `/api/timds/me` | The signed-in principal `{id,type,name,admin}` |
| GET | `/api/timds/design-systems` | Systems visible to the signed-in principal |
| GET | `/api/timds/design-systems/:id/releases/:label/source` | Immutable source export for `shoot` / `feed` |
| GET/POST | `/api/timds/design-systems/:id/drafts` | List, or create `{name,from,idempotencyKey?}` |
| GET | `/api/timds/design-systems/:id/drafts/:name/snapshot` | Authenticated draft source |
| POST | `/api/timds/design-systems/:id/drafts/:name/close` | Close draft and live resources |
| POST | `/api/timds/design-systems/:id/rollback` | `{version,dryRun?}` |
| POST | `/api/timds/sessions/:id/close` | `{apiVersion:1}` |
| POST | `/api/timds/submissions/:id/publish` | `{apiVersion:1, preflight?, dryRun?}` |
| GET | `/api/timds/publications/:id` | Publication progress and result |

A change set is `{apiVersion:1, baseRevision, lastUpdateHash, changedFiles, deletedPaths,
note?}`. Files are `{path, encoding:"base64", content, mode?}`; modes are
`100644`, `100755`, or `120000` (a bounded relative symlink). Responses carry
`apiVersion:1`; snapshots carry `session:{id,systemId,baseRevision,status,
expiresAt?}` and `files`. Update/submit conflicts carry `conflicts:[{path,key?,base,mine,theirs}]` and
`mainRevision`; successful updates return the merged fork snapshot. Submit
returns the updated session and a submission with its `previewUrl`, and can
omit `files` when the submitted local snapshot is unchanged by the host.
Snapshots are capped at 4,000 files and 50 MiB of raw content, with at most
10 MiB per file. A submitted change set remains capped at 10 MiB total. Nested
`.gitignore` rules exclude new ignored files while already tracked snapshot
files remain eligible, matching consumer checks. Traversal, credential files,
`.git`, unsafe symlinks, and session metadata are excluded. Host storage and
publication remain host responsibilities; no reference host is shipped.
