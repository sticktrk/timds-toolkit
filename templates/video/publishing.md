# Platform descriptions

`contract.json` owns `publishing.targets`: `youtube_short`, `facebook_reel`,
and `instagram_reel`. Each has a writing `brief` and a final `maxCharacters`
budget plus a `maxCopyCharacters` budget for the authored text. A target may override `shortBridge`, `shortDisclaimer`, and
`shortArticleLink`; omitted values inherit `publishing.targetDefaults`, then the legacy publishing policy. Target defaults apply only to platform variants, preserving old records.
Use client-owned wording and URLs. Empty starter campaign copy needs no account.

In each short's `publishing.json` record, author separate copy from that clip's
script. Keep links, series labels, and disclaimers out of these draft strings;
the formatter adds them according to the contract:

```json
{
  "id": "example-short",
  "descriptions": {
    "youtube_short": "One small change makes this task easier. Here is the first step.",
    "facebook_reel": "Getting started can feel complicated. This clip walks through one practical first step.",
    "instagram_reel": "Start small. One practical step to save for your next attempt."
  }
}
```

`timds video check` checks every opted-in short for missing target copy and
final length. `timds video publishing SLUG` exports `description.TARGET.md`
beside each short, without rendering or provider credentials. Rendering uses
the same export. `description.md` aliases the YouTube Short for compatibility;
`publishing.json` also records the compiled platform descriptions.

Existing projects adopt this by adding reviewed target policies to their
contract, then adding a descriptions map to selected production records.
Records without that map keep their legacy output. Normal `timds upgrade`
does not rewrite authored contracts or production records.
