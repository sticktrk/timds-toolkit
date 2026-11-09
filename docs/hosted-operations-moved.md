# Hosted operations moved to the host repository

Material about running or administering a TimDS host no longer lives in this
public toolkit. It now lives in the host repository (`sticktrk/timds-host`).
This repository documents only what a toolkit user needs: the local and Git
workflow in the [README](../README.md), and the client side of the hosted
service in [TimDS Cloud](timds-cloud.md). See "Public toolkit boundary" in
[AGENTS.md](../AGENTS.md) for the rule.

Moved out of `README.md`:

- **Hosts share the pure three-way merge** (`@dtconcepts/timds/merge`,
  `mergeFileTrees`, its tree format, merge semantics and conflict receipts).
  The host now carries its own copy; the toolkit export is deprecated.
- **Trusted hosts can publish without a local checkout**
  (`publishReleaseFromFiles`, `createPublicationStampFromFiles` from
  `@dtconcepts/timds/publish` and `@dtconcepts/timds/publication-snapshot`,
  `prepareMergeRelease` from `@dtconcepts/timds/release`, and the publisher
  callback's response contract). The exports are unchanged.
- **Fleet controllers** registering repositories and dispatching adopted
  dependency-upgrade workflows (from "Opt-in dependency PR automation").
