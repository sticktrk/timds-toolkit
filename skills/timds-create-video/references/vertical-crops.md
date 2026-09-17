# B-roll vertical crop records

Use this contract when creating or registering B-roll in a Design System with
TimDS video enabled. The designer owns the subject framing and review. TimDS
checks the metadata and applies the approved position; it does not run object
detection or track a moving subject.

## Where the records live

`timds.json → video.verticalMetadata` names a repository-relative JSON file.
New video scaffolds configure `video/vertical-meta.json`. `video/assets.json`
continues to own media keys, measured durations, horizontal layout, and links
from masters to published `vertical` derivatives. Crop decisions live in the
separate registry, keyed by the master's **video asset key**, including any
offset or mirrored masters registered for the producer.

```json
{
  "schemaVersion": 1,
  "assets": {
    "footage-example": {
      "sourceSha256": "1111111111111111111111111111111111111111111111111111111111111111",
      "objectPosition": "85% 50%",
      "text": "lower",
      "reviewedFrames": ["first", "middle", "last"]
    }
  }
}
```

The hash above is illustrative. Copy the actual master hash from its published
`media.json` entry; never invent a hash or record a review that did not happen.
`objectPosition` must be two percentages from 0 to 100, and `text` must be
`upper` or `lower`. These fields describe the **vertical** crop and headline
zone. Keep the master's horizontal `text` placement in `video/assets.json`.

## Author and review

1. Inspect the wide master for its important people and objects across the
   shot. Subject-side labels help find them but do not establish a safe crop.
2. Choose the framing for the client's Short dimensions. Prefer producing and
   publishing a vertical derivative, then linking it with the master's
   `vertical` field. Keep faces and the relevant action in frame and leave the
   chosen headline zone clear. Moving subjects may need a tracked/reframed
   derivative; a fixed position cannot follow them.
3. For a live crop, review `object-fit: cover` at the declared `objectPosition`
   with the client's actual components, zoom, flip behavior, and text overlay.
   The percentage aligns the image within the overflow; it is **not** the
   subject's fractional coordinate in the original image. Do not directly copy
   a legacy `centerFrac` into this field. For a full-height crop, the horizontal
   percentage is `100 * cropX / (sourceWidth - cropWidth)`. If an old crop uses
   an additional zoom or another framing transformation, use the reviewed
   derivative instead of assuming this formula reproduces it.
4. Review the first, middle, and last frames and any intermediate motion that
   could cross the crop boundary or collide with text. Record `reviewedFrames`
   only after inspection. Re-review when replacing the source or changing the
   target dimensions, crop, or components. For linked derivatives, inspect the
   derivative as well; its existing framing takes precedence over a live crop.
5. Register and publish media through TimDS under the user's media-authoring
   authorization. Commit the stable `media.json`, video asset map, and crop
   registry together, preserving the repository's normal submission rules.
   Never commit source videos or ignored caches.
6. Run `npm run timds -- video check` (also included in `timds check` and
   submission validation). A configured registry is checked for
   **all** producer footage masters even if no saved input uses them. Missing
   records, invalid positions/zones, incomplete review markers, mismatched
   source hashes, and missing linked derivatives fail the check and workspace
   loading before rendering. This verifies the record, not the visual review.

`producer.footage.allowShortCrop` defaults to false. Enabling it allows a
published master with a validated record to fill a missing vertical link.
Without either a linked derivative or a reviewed crop plus that opt-in, the
producer reports that the Short has no eligible footage. A mixed chain may
use both. Cropped masters retain their measured duration and footage family.

## Existing libraries

Keep existing approved derivatives. A client's older `vertical-meta.json` may
contain pixel rectangles, free-text placement rules, or names without the
video asset prefix. That is useful source material, but it is not automatically
this schema. During an authorized catalog update, map records to the actual
master asset keys, verify the current source hashes, translate and review the
framing, and supply the complete registry before setting `video.verticalMetadata`.
Do not guess missing crop decisions or rewrite client metadata during an
ordinary toolkit upgrade. Existing catalogs without the manifest setting keep
their derivative-based behavior; they cannot use the live-crop fallback until
they supply the registry.
