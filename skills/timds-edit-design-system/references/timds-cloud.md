# TimDS Cloud reference for editing a Design System

This reference belongs to the `timds-edit-design-system` skill. Read it only
when the Design System lives on a TimDS host (a hosted session workspace, or a
`timds.json` whose `provider` is `{ "kind": "hosted" }`). The local and Git
flow in `SKILL.md` stays the default.

## Hosted sessions

Agents are the only writers. Humans direct work and use login, status,
history, publish and rollback in the CLI or Studio. Drive hosted sessions with
the TimDS CLI only. Inside a Design System repository run it as
`npm run timds -- <command>`. A hosted workspace, or any folder without that
npm script, runs `npx --yes @dtconcepts/timds@latest <command>` (or a global
install of `@dtconcepts/timds@latest`); always `@latest`, never a pinned
version. Below, `timds` stands for whichever applies. The session commands
are `timds start`, `join`, `pull`, `update`, `submit`, `claim`,
`active-work`, `whoami`, `systems`, `principals`, `draft create|list|close`,
and `sessions close`. When the human names a design system you have no id
for, `timds systems` lists every system the signed-in person can see.
Outside a session workspace, `active-work`, `principals` and `draft`
commands need `--system-id ID` and `--portal-url URL`: only `start`, `join`,
`whoami` and `systems` fall back to the saved login.

Join before you start. When the human names an open session (a session id, a
Studio link, or "the session I have open"), attach to it and send work with
`timds update`; do not create a second session with `timds start`. A Studio
link is the whole invitation: `timds join "LINK"` uses the link's host, signs
in there if this machine has not, and attaches in a new `./session-ID`
folder. With a bare id, use `timds join SESSION --root ./NEW-FOLDER`, and find
the id in `timds active-work` when the human did not give it. Join needs an
empty folder: never reuse a workspace that already holds files or another
session. Use `timds start SYSTEM --root ./NEW-FOLDER` only when there is no
session to join or the human asks for a new one. If the host refuses the join
(`Session not found` or a 403), the signed-in principal has no access to that
session: report the id from `timds whoami` so the owner can invite it, and do
not start a separate session as a workaround.

Read active work with `timds active-work` before editing, then claim the
intended paths with the human's intent:
`timds claim --on "GLOB,GLOB" --note INTENT`. Overlap is advisory; do not
edit paths another agent has claimed, tell the human about the overlap
instead. `timds update --note INTENT` and `timds submit --note INTENT` carry
that intent (required for agent principals). Never run git or handle
Artifacts credentials in a hosted agent workspace.

`timds auth login` selects the workspace's hosted provider unless `--portal-url`
explicitly selects another host. Existing credentials are reused; `--force`
authorizes again. Outside a workspace, the last successful login host is
remembered, so `timds start SYSTEM --root PATH` can reuse it without another
portal flag. Install the materialized workspace dependencies before `dev`.
Hosted `doctor` needs no Git; a busy local port can be changed with
`timds dev --port PORT` (sets `PORT` for the declared dev command). Independent hosts use OAuth with a temporary
loopback callback; portals keep device login. Let the human complete sign-in.
`--no-browser` prints the link, and a remote shell needs loopback forwarding or
the portal's `--device` flow. Credentials and refresh tokens stay outside the
workspace; never copy them into a prompt, source file or session metadata.

Author token key maps under `tokens/` and media key maps under `media/`
when `.timds/contract-layout.json` exists; an edit to the generated
`tokens.json` or `media.json` is left out of every update and submit. A
change set is limited to 10 MiB, so large media goes through `assets add`
and the asset store, never into the session. Run check for reference
integrity and build validation. Hosted `submit` refuses, like Git `submit`,
while `CHANGELOG.md` has nothing under `## Unreleased`; write the note
first. When the session moved while
you worked, `timds pull` brings its current files into the workspace and
keeps your edits. Key conflicts return exactly `path`, `key`, `base`, `mine`,
`theirs`; resolve with
`timds update --resolve 'PATH#KEY=mine|theirs' --note INTENT`. A plain PATH
keeps the local file. A stale shared session preserves edits and current
content; the toolkit reapplies a clean server rebase patch and retries once.
Further stale changes need a fresh read and explicit retry, never a force push.

A draft is a named non-expiring session: `timds draft create NAME`, then
`timds start SYSTEM --draft NAME --root ./NEW-FOLDER` to target it;
`timds draft list` shows the open drafts and `timds draft close NAME` ends
one. An owner or publisher invites a second principal with
`timds join SESSION --principal-id ID`; that member runs `timds join SESSION`
to attach. `timds whoami` gives the caller's own principal id and
`timds principals` lists who can be invited. `timds sessions close` closes the
workspace's session, only when the human asks. Return the live URL,
submission preview and claims with the work receipt. When publication is
requested, run dry-run, review it, then publish with explicit confirmation.
Never put access tokens in source or session metadata.

## Publish media to the host

This release supports public media only. Never commit full-resolution images,
video masters, B-roll, source audio, or other large originals to Git or `dist/`.
Copy the file into the ignored `media-local/` workspace and register a stable
logical key:

```bash
npm run timds -- assets add media-local/file.mp4 \
  --key descriptive-key \
  --title "Descriptive title" \
  --tags b-roll,campaign
```

Reference the asset from pages by what resolves everywhere: the starter viewer
resolves `{{media:KEY}}` to the catalog record's regular `src/assets/` path
(small display files such as a logo), never to a remote URL, so a
published-only asset is referenced by the stable `publicUrl` in its record.
A framework viewer can resolve keys with `resolveMediaSource` and serve
staged files with `localMediaResponse` from `@dtconcepts/timds/media`.
Authenticate through the operator portal (`auth login --portal-url` with
`timds.json` `media.portalUrl` when it is not the default host) and upload:

```bash
npm run timds -- auth login
npm run timds -- assets publish
```

`submit` publishes changed staged files automatically before validation in a
Git checkout; a hosted `submit` does not, so publish first there. Commit the
resulting catalog record (`media/<group>.json` plus the regenerated
`media.json`, or `media.json` alone without a contract layout), never the
raw file or local manifest.
`assets add` records the catalog checksum when staging. `assets publish` and
`submit` stop before uploading if a staged replacement conflicts with the
current catalog, including older staging entries without that baseline. Keep
reviewed published derivatives: remove stale entries from
`.timds/local-media.json` or run `assets pull KEY --force` to restore the
published asset. Restage with `assets add FILE --key KEY` only after reviewing
an intentional replacement; never restage originals over optimized keys merely
to bypass a conflict. Reusing an asset ID belonging to another key is rejected
without deleting that key; reference the existing logical key instead.

TimDS
uses `ffprobe` while staging video and audio so the record and published machine
index include measured duration and video dimensions. For an older catalog,
run `npm run timds -- assets backfill-metadata` once to measure its stable public
URLs without uploading the blobs again. Never
commit credentials, storage keys, or expiring signed URLs. Use
`npm run timds -- assets pull LOGICAL_KEY` to restore a published asset on a new
workstation. `TIMDS_ACCESS_TOKEN` is the non-interactive alternative for an AI
agent or CI job.

## Portal promotion

Portal promotion respects the system's Automatic updates setting. ON publishes
and verifies the public root; OFF reports a candidate waiting for an operator.
When explicitly authorized to release, run `npm run timds -- publish`: it builds,
pushes the artifact ref, and sends its local stamp using an unbound operator
token (`auth login` or `TIMDS_ACCESS_TOKEN`). It prints the root and pinned URLs,
or the portal action for a waiting candidate. A repeated live stamp is a no-op;
stale or mismatched bytes fail. `extract --publish` only uploads CDN files. Do
not enable Automatic updates or substitute client-bound/consumer credentials
to get publication through.
