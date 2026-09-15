# Video lab inputs

Each JSON file here is one compile request for the `producer` block in
`../contract.json`: the exact question, a two-to-four-word topic label, the
engagement question when the block requires one, and ordered answer beats with
a semantic role (`hook`, `rule`, `risk`, `process`, `exception`, `answer`), the
spoken narration, and a complete micro-headline summary. It is the same input
an automated Video Lab hands `createVideoProducer().compileProduction()` after
a model writes to the authoring contract, so the lab previews exactly what
that lab would ship through this Design System's components.

```bash
npm run timds -- video lab                   # first input here, in Remotion Studio
npm run timds -- video lab NAME              # NAME.json in the studio
npm run timds -- video lab NAME --plan       # compile + finalize; print the plan
npm run timds -- video lab NAME --prepare    # stage media and write the entry only
npm run timds -- video lab NAME --render     # render the video and cover locally
npm run timds -- video lab --list            # inputs and ready productions
```

The lab compiles the input through the producer block, times the narration
silently at reading speed (a voiced production replaces this with measured
word timings), finalizes footage and cover deterministically from the
registered catalog, stages brand files and published media under ignored
`video-local/lab/`, and mounts TimDS's single-format root with the declared
`video.components` module or the TimDS defaults.

An input is a preview fixture, not a production. It carries no source,
authorization, publishing, or caption record, and nothing here renders into a
review package. Finalizing needs footage registered under the producer's
`footage.assetPrefix` keys with measured durations and at least one published
image under its `cover.assetPrefix` keys. `timds video check` compiles every
input here (a broken request fails the check) and warns when the registered
catalog cannot finalize one yet.
