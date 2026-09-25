# Tag semantics pipeline

Builds `public/tag-semantics.json`, the optional semantic-map asset served by the
background's `similar` RPC (curated relatives shown alongside the live variant scan).

Pipeline (re-run when the corpus drifts):

1. **Dump the corpus** — with the extension loaded and the tag cache synced
   (`status.complete === true`), evaluate on any extension page (e.g. options):
   read all rows of IndexedDB `cllp-feed-tags`/`tags` as `[{id, name, rank}]`
   and save as `corpus-raw.json` (~88k tags).
2. **Cluster surface forms** — `node cluster.mjs corpus-raw.json clusters.json`
   collapses case/punctuation/underscore decoration, singular/plural (incl.
   irregulars), token reorderings, and guarded 1–2-edit typos into clusters
   headed by the most popular form.
3. **LLM taxonomy** — split the top ~4k cluster heads into chunks and have LLM
   agents classify each `{id, name}` into `{id, cat, concept, akin?, gender?}`
   JSONL (see the prompt embedded in the repo history / session logs: fixed
   category list, canonical core concept, optional akin-concept link).
4. **Build the asset** —
   `node build-asset.mjs clusters.json ../../public/tag-semantics.json taxonomy-*.jsonl`
   merges everything into the shipped asset: `heads` (variant member → cluster
   head), `related` (head → same-concept + akin heads), `cat`/`categories`.

The extension works fully without the asset (the live variant scan covers
typos/plurals); the asset adds cross-concept relations like gown ↔ dress and
gendered garment variants.
