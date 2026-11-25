# Brand concepts

A concept proposes a brand direction and records the pieces that show it. The system's tokens define its colors and type. Take colors, fonts and media from the system. Read a concept to learn the direction and its reasons, or because the task is about that concept.

## Author a direction

Put one proposal in `src/concepts/<id>/`. Choose a permanent lowercase, URL-safe id. Keep that id through revisions and never reuse a published id. Both starters include a small `sample` direction you can edit or remove. Existing systems can run `timds concepts init` to add the sample. Use `timds concepts add ./field-notes --id field-notes` to import a manifest, its validated pieces and their local dependencies. Other files stay in the input folder.

A minimal `concept.json` for a folder containing a `mark.svg` reads:

```json
{
  "schemaVersion": 1,
  "title": "Trail markers",
  "summary": "An alpine trail marker anchors a field journal.",
  "pieces": [{ "kind": "logo", "file": "mark.svg", "alt": "Three ridges above a pine line" }]
}
```

Each concept has a title, summary and at least one ordered piece. Set `status` to `proposed` (the default), `approved` or `archived`. A system can have one approved concept at a time. The optional `decided` field gives the decision date as `YYYY-MM-DD`. A revised proposal keeps its id. When a new direction supersedes an approved one, archive its predecessor in the same edit.

Optional fields record the proposal's foundations:

- `colors.roles` maps brand-kit role names to six-digit hex colors. `colors.palette` lists swatches as `{ "name": "Pine", "hex": "#25372E" }`.
- `fonts` names display, body and optional label faces with a family and weight. `voice` is an array of short phrases.
- Each piece has a `kind` and local `file`, with optional `alt`, `caption`, `label`, `side`, `ground` or `height`. Give images alt text that describes the piece.

The supported kinds are website, logo, card, social, photo, merch, pattern and other. Keep HTML, CSS, SVG, PNG, JPEG, WebP and WOFF2 assets in the concept folder. A concept accepts up to 60 pieces, with at most 512 KiB per HTML mockup and 8 MiB per image. References stay inside the folder, and previews run in script-free sandboxed frames. A concept can use its own colors and styles.

## Review and reference

Open `/concepts/` in the preview. The directory puts the approved direction first. Each direction has a permanent page at `/concepts/<id>/` with anchors for the kinds it contains. Every status, including archived, is published with the artifact. Keep private working material out of a public release.

Use `{{concept:field-notes}}` in a page to show a card. `{{concepts}}` lists every card, `{{concepts:approved}}` selects a status, and `{{count:concepts}}` renders the number of concepts. Run `timds check` to validate sources, build the section, and refresh its Markdown mirrors and `concepts.json`. Unknown optional manifest keys produce a warning so later readers can extend schema version 1. A versioned system holding proposals with no approval also gets a warning.

Code imports the shared reader, normalizer and vocabulary from `@dtconcepts/timds/concepts`. MCP clients use `list_concepts` and `read_concept`. A structure offshoot starts without its parent's proposals, and parent feed and starter sync leave the child's concepts alone. Consumer bundles omit concept sources and previews.
