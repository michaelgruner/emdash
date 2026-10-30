---
"@emdash-cms/admin": minor
"emdash": minor
---

Adds inline rich content to plugin-defined Portable Text blocks through the optional `content` definition. Authors can edit formatted text and nested blocks in the admin editor using its existing toolbar, slash menu, and undo history. Repeating content supports adding, reordering, removing, and editing item options.

Set `content.field` to the block's Portable Text array property. Set `content.items` when the array belongs to each item of a repeating field. Existing blocks remain opaque unless their plugin opts in. An optional `legacyField` converts plain text during editing; saving writes the rich content to the configured field. Nested media insertion is disabled while existing nested media is preserved.
