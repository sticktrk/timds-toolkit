# Installed toolkit release metadata

`@dtconcepts/timds/release-metadata` is a read-only Node ESM export for hosts and
build tools. It works from the published npm tarball without the toolkit source
checkout or installed dependencies. It describes **the exact imported package**;
it never resolves `latest`, fetches another version, initializes a repository,
runs a build, or reads user configuration. Hosts select and independently verify
the npm tarball/lockfile integrity before importing it. A package cannot include
its own final tarball integrity without changing that integrity.

```js
import {
  describeToolkitRelease,
  readToolkitReleaseResource,
  renderToolkitManagedFiles,
} from '@dtconcepts/timds/release-metadata';

const selection = {schemaVersion: 1, starter: 'brand-kit'};
const release = await describeToolkitRelease(selection);
const rendered = await renderToolkitManagedFiles({
  ...selection,
  hostedSkill: {
    portalUrl: 'https://host.example.com',
    systemId: 'example/core',
    systemName: 'Example Design System',
    studioUrl: 'https://host.example.com/studio/example',
  },
});
const manifest = rendered.files.map(({path, mode, sha256, policy}) => ({path, mode, sha256, policy}));
const seed = release.files.find(file => file.path === 'src/pages/index.html');
const template = await readToolkitReleaseResource(seed.resource, selection);
```

The schema version defaults to `1`, and the starter defaults to `starter`.
Only `starter` and `brand-kit` are supported. Unknown schemas, starter kinds,
options, undeclared resource paths, missing required resources, and symlink or
special-file resources fail explicitly. Each call returns fresh objects.
Paths use `/`; entries are sorted by path with code-point ordering. The same
explicit inputs and package bytes produce the same result regardless of working
directory, time, timezone, saved host settings, or binary-runtime environment.
This export always describes **npm** output, including hosted skill rendering.

## Descriptor and resource bytes

`describeToolkitRelease(selection)` returns:

- `schemaVersion`, `starter`, and `toolkit: {name, version}` identifying the exact
  installed package, independently from the metadata schema.
- `resources`: unique package-relative paths with raw `sha256`, UTF-8 byte count
  `bytes`, and canonical Git file `mode` (`100644` or `100755`). These hashes
  describe packaged resources, including unrendered templates.
- `files`: output `path`, resource lookup key `resource`, replacement `policy`,
  and `operation`; parameterized operations also list their `parameters`.
- `symlinks`: `.claude/skills`, target `../.agents/skills`, mode `120000`, and
  the `create-if-absent` policy shared with initialization and upgrade.
- `starterSteps`: `{level, floor, steps}`, the starter level a fresh scaffold
  of this release starts at, the oldest level it supports, and every starter
  step above the floor as data. See [Starter steps](#starter-steps).
- `generated`: version metadata records and package initialization inputs,
  separate from resource content. These are declarations, not pre-rendered
  records or an exhaustive inventory of a built scaffold.

`readToolkitReleaseResource(packagePath, selection)` returns one declared
resource's metadata plus UTF-8 `content`. Arbitrary paths and resources belonging
only to the other starter are refused. Template selection and automation paths
are shared with init/upgrade, and the plumbing, fragment, and skill sets come
from the same definitions that starter sync and skill installation use.

## Ownership and rendering

| Policy | Meaning |
| --- | --- |
| `starter-plumbing` | Toolkit-owned when the starter record says `plumbing: "toolkit"`; otherwise replace only recognized stock hashes, subject to the existing sync policy. The build, check and dev scripts are stubs that call `@dtconcepts/timds/viewer`; the renderer is never copied. |
| `stock-fragment` | Ordinary starter pages; refresh only while unchanged. Customized fragments are authored and are never force-replaced. |
| `managed-skill` | The six design-system skills copied by init/upgrade. |
| `hosted-skill` | Parameterized hosted skill; require explicit system identity before trusting any output path/hash. |
| `release-automation` | Standalone release files; require standalone initialization or explicit auto-release adoption. |
| `dependency-automation` | Dependency PR workflow; require explicit dependency-PR adoption. |
| `catalog-merge` | Site/format catalogs use their recorded three-way merge; a raw template hash is never replacement permission. |
| `layout-patch` | Only missing stock stylesheet links may be added to the authored layout. |
| `seed-only` | Initial content owned by its author thereafter. All brand-kit pages are seed-only, including its Use pages, and so is its website design under `src/designs/website/`. |
| `version-metadata` | Generated installation/starter records, distinct from authored content and from managed-file changes. |
| `create-if-absent` | Create the declared link only when nothing exists at its destination. |

`renderToolkitManagedFiles(options)` returns `{schemaVersion, toolkit, starter,
files}`. Each file has `path`, `mode`, `content`, `sha256`, and `policy`. The hash
is over the **final UTF-8 content**; for the symlink, content is the literal
relative link target. File modes are canonical fresh-package modes. Upgrading an
existing file may preserve its current mode; this API does not mutate files or
decide which existing paths a host is authorized to replace.

The default render includes starter plumbing, ordinary stock fragments, managed
skills, and the conditional Claude skills link. Catalogs, authored layouts,
seeds, and generated installation records are excluded. `releaseAutomation:
true` and `dependencyAutomation: true` explicitly include their respective
conditional managed sets; their defaults are false. A `hostedSkill` object uses
the same renderer as `timds skills install` and adds its rendered files under
`.agents/skills/<resolved skill name>/`. `portalUrl` and `systemId` are required;
`systemName` defaults to the system ID and `studioUrl` to the host's `/studio/`.
A hosted destination colliding with a toolkit skill is rejected.

The descriptor's hosted path contains `__SKILL_NAME__` and its resource hashes
cover placeholders. These are **not** final trusted paths or rendered hashes.
Only the renderer's result can supply those. Hosts should independently enforce
supported schema, policies, path and mode constraints, adoption records, and
recognized previous hashes before installing anything.

## Seed transformations and host responsibilities

Raw seeds are not a promise that copying templates reproduces all of `timds
init`. The descriptor names the applicable operations:

- `copy` means verbatim seed bytes.
- `replace-placeholders` requires explicit replacements. For npm docs the CLI
  is `npm run timds --`; contract description, dist/media/skill locations depend
  on standalone versus embedded layout. `CHANGELOG.md` needs an explicit
  `__VERSION__` baseline label, normally `YYYY.MM.DD-1`.
- `initialize-manifest` requires identity, baseline version, layout, provider,
  description and optional consumer configuration. The CLI also applies these
  fields to the parsed template and serializes JSON.
- `contract-groups` migrates token/media seeds into grouped contract files;
  `append-ignore-lines` adds selected standalone/hosted ignore entries.
- `three-way-merge` and `patch-missing-links` describe existing sync operations,
  not instructions to replace the entire resource destination.

The CLI's current initialization derives its initial date from the clock and
its default repository identity from the target directory. This metadata API
never does so. A host preparing deterministic seed scaffolds must explicitly
select those inputs and retain its own initializer policy. The export is not a
replacement for the full CLI initializer: generated package/manifest records,
contract migration, build output and host-specific files remain separate.

Hosts own Preview script conversion, lockfile generation, artifact storage,
publication policy and target selection. Host transformations invalidate the
pre-transformation rendered hash, so hash the final bytes separately. The
metadata does not authorize replacing authored content and does not supply a
trusted external-package integrity assertion.

For a compact release comparison, compare rendered entries by path, mode and
hash using identical explicit inputs. Report added/removed/changed managed paths
separately from seed resource changes, generated records and `toolkit.version`.
A version-only record change must not be presented as an authored-content
change. The selected package's npm integrity remains a separate provenance
field in the host's artifact.

## Starter steps

This release publishes `{ "level": 1, "floor": 1, "steps": [] }`.
`starterSteps.steps` lists the numbered steps above the floor:
`steps[i].level` is `floor + 1 + i`, so there are `level - floor` of them.
Raising the floor prunes the steps at or below it. Each step is exactly
`{level, id, layer, visible, declinable, starters, requires, operations}`:
`layer` is `code` (every system, offshoots included) or `defaults` (only the
starter kinds in `starters`, never an offshoot). The vocabulary is closed:

| Operation | Shape | Meaning |
| --- | --- | --- |
| `remove-file` | `{op, path, sha256}` | The file leaves only when the SHA-256 of its exact bytes (lowercase hex) is in `sha256`, which lists every stock version a release shipped at that path. Any other content is a conflict. |
| `set-site-field` | `{op, field, value, from}` | A top-level `src/site.json` field moves to `value` when its current value is in `from` (`null` means absent); otherwise it is kept. Never `views`; `value` is never `null`. |
| `set-page-field` | `{op, page, field, value, from}` | The same for one field of page `page`: `view` is that view's own page (empty or missing slug), `view/slug` another page. Never `slug` or `pages`. |

| Requirement | Shape | Meaning |
| --- | --- | --- |
| `stock-file` | `{check, path}` | The file equals this release's rendered managed bytes (`renderToolkitManagedFiles`). |
| `authored-page` | `{check, page}` | The page is declared and not `planned`. |
| `page-field` | `{check, page, field, equals}` | The page's field equals `equals`. |

Requirements are checked first; when one fails, the step does not apply to
that system and settles unchanged. The toolkit's `starter sync`, `upgrade`
and `starter migrate` apply exactly these definitions through one
interpreter, so a host can verify a candidate change from the data alone: a
level that crosses a step shows that step's effective operations (a
`remove-file` whose prior bytes match, a field move whose prior value is in
`from`), crosses a visible step only when the step had none, crosses a step
whose requirements fail or whose `starters` or layer do not fit the system
unchanged, and leaves `declined` as it was. A step that settles with nothing
to change is recorded by `level` alone; `declined` is written as `[]` when
empty. A record without `level` predates starter levels and is below the
floor. [Upgrading in depth](upgrade.md#starter-levels) describes the rules
and the status a system reports.

`package.json` `hostContract` names what a host must implement to accept this
release's upgrades. It is `2` from the first release with starter levels: an
upgrade writes the stub scripts and records `level` and `declined`, steps may
remove files and move catalog fields, and a system below the floor is refused
rather than upgraded. A new operation or requirement raises it, so a host that
does not know it holds the release instead of guessing.

`package.json` `emdashTemplate` names the EmDash template set this release
installs (`consumer scaffold emdash --workspace`, see
[EmDash sites](emdash.md)):

```json
"emdashTemplate": {
  "version": 3,
  "history": [
    { "version": 1, "changes": ["The first template set: ..."] },
    { "version": 2, "changes": ["Declared sections, shared schema, routes, feeds and mixed lists."] },
    { "version": 3, "changes": ["Nested section prefixes and a shared route inventory with explicit reference pages."] }
  ]
}
```

`version` equals `templates/emdash/site.json` `version`, the `template` a
site records in `.timds/emdash.json`; `history` has one entry per version from
1, each with a short list of what that version changed. Like `hostContract`
it is in the registry document, so `npm view @dtconcepts/timds emdashTemplate`
reads it without unpacking the package. It is not part of the
`release-metadata` export: the site's files are product source, outside the
managed resources above. For maintainers: a template change an installed site
would need to receive raises `version` in both places and adds a `history`
entry; `src/emdash-template-metadata.test.mjs` fails when the two disagree or
a version has no entry.

A release that writes template version 3 declares `emdashWorkspaceContract: 3`
and `emdashSectionsContract: 2`. Its fresh `sections.json` uses declaration
version 2 for nested literal prefixes inside one Design System; builds export
section contract 2. This first hosted-site release supports only that current
contract; historical declaration versions are refused. Hosts must accept the
complete capability tuple before scaffolding and acknowledge section contract 2
during hosted builds. Standalone Astro builds need no host acknowledgement.
The contract does not require an `articles` collection. Recorded template
history describes development revisions, not supported deployment formats.

## Compatibility and verification

Schema 1 fixes the data shapes and policy meanings above. Package releases may
add/remove/change resource entries; hosts must fail closed on unsupported
schema/policy values instead of inferring ownership from a path. Legacy hosts
can retain CLI generation until they select a toolkit release with this export.
No release publication or host dependency bump is required to prepare that
fallback.

`src/release-metadata.test.mjs` checks both kinds against actual initialization,
template versus rendered skill hashes, authored/conditional boundaries, packed
package import and declarations outside the checkout without dependencies,
deterministic explicit inputs, and invalid schema/resource failures. Run
`npm test` and `npm run pack:check` before publishing a release containing a
metadata change.
