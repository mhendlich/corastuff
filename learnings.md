## New stack learnings

- The TS worker drops scraped products without a non-empty `itemId` before calling `products:ingestRun`; we now persist this as `runs.missingItemIds` (set on completion) so the UI can warn per source even though those products never reach `productsLatest`.
- `links:countsBySource` now returns `missingItemIds` from the latest successful run, alongside linked/unlinked counts.
- The multi-source unlinked queue uses `links:listUnlinkedPage` which merges per-source scans in-memory; it reports `truncated: true` when it had to cap per-source scanning.
- `Panel` needed broader typing (`ComponentPropsWithoutRef<"div">`) to allow click handlers like `onClick` in TS.
- Link workbench bulk actions are backed by Convex `links:bulkLink` (deduped up to 250 items) plus `links:getUnlinkedByKeys` for validating bulk selections.
- Link suggestions are currently heuristic (token overlap + name substring) via `links:suggestCanonicalsForProduct` (per item) and `links:smartSuggestions` (bulk groups); if suggestion quality becomes an issue, tighten thresholds or add domain-specific signals (brand/vendor tokens, SKU normalization).
- For “manual” sources (e.g. Amazon before a scraper exists), writing directly to `productsLatest` + `pricePoints` without setting `sources.lastSuccessfulRunId` avoids “latest run” filtering hiding previously-entered items; `products:listLatest`/`links:*` fall back to `by_sourceSlug_lastSeenAt` when there is no `lastSuccessfulRunId`.
- Amazon opportunity logic now lives in Convex (`amazon:pricingOpportunities`): it joins `canonicalProducts` + `productLinks` + `productsLatest` and classifies `undercut`/`raise`/`watch` plus missing-data buckets; the `/amazon-pricing` page consumes it directly.
- Scraper monitoring UI now lives at `/scrapers` (overview) and `/scrapers/history` + `/scrapers/history/:runId` (run history + detail); `/history` is currently an alias to the same history page.
- `runs:listRecent` now allows up to 200 rows, which keeps the history page usable without adding a dedicated filtered index yet.
