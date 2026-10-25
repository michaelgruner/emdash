---
"emdash": minor
"@emdash-cms/admin": minor
---

Adds opt-in hierarchical collection URLs through `hierarchyRelation` and a URL pattern ending in `/{path}`. A self-relation with one parent per child defines each entry's ancestors; the admin edits the final URL segment and stages moves with the draft.

Publishing a rename or move updates the subtree's canonical slugs, references, and native permanent redirects atomically. Existing automatic redirects point directly to the latest URL. Publication rejects cycles, duplicate paths, unpublished ancestors, conflicting descendant location drafts, and moves the acting user cannot publish. Parents with published descendants cannot be unpublished or deleted.

Hierarchical collections require revision support and a single content locale. Existing collections keep their current URL behavior until explicitly activated through the collection schema API. Sites serving hierarchical entries must use a catch-all Astro route and load the full slug with `getEmDashEntry()`. The `emdash/urls` entrypoint supplies segment-aware path encoding and decoding. Existing `{slug}` patterns retain their encoding behavior.
