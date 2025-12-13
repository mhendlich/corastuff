# TODO (Feature + UI/UX parity)

Goal: reach feature + UI/UX parity with the “old” FastAPI/Jinja/HTMX webapp in `src/webapp` using the “new” stack in `new/` (React/Vite/Tailwind + Convex + BullMQ worker + Caddy proxy/media).

This list is based on a code-diff of:
- Old UI/routes: `src/webapp/routes.py` + templates in `src/webapp/templates/`
- Old data/logic: `src/db.py`, `src/job_queue.py`, `src/scheduler.py`, `src/worker.py`, `src/scrapers/*`
- New UI: `new/apps/web/src/App.tsx`
- New backend/data: `new/convex/*`, `new/apps/worker/src/*`, `new/packages/*`, `new/docker-compose.yml`

## 0) Parity blockers (foundation)

- [x] Add authentication + session handling (old: `/login`, `/logout`, cookie `session_token` in `src/webapp/auth.py`)
  - [x] Gate all UI routes and all Convex-driven data access behind auth (not just “hide UI”).
  - [x] Decide where auth lives (SPA login + per-function `sessionToken` arg; password via Convex env `CORASTUFF_PASSWORD`).
  - [x] Add logout + session invalidation; add “already logged in” behavior (persisted session token).
- [x] Add proper app shell + routing (old: sidebar + topbar in `src/webapp/templates/base.html`)
  - [x] SPA routes matching old pages (Dashboard, Insights, Products, Link Products, Prices, Amazon Pricing, Scrapers, Automation/Schedules, History, Scraper Builder).
  - [x] Shared layout: sidebar nav, page titles/subtitles, breadcrumbs, page actions (logout).
  - [x] Split current `DashboardPage` into real per-route pages (so `/link` is its own page, not the dashboard).
- [x] Make “latest scrape” semantics match old behavior (old queries always target the latest `scraped_at` per source)
  - [x] Track latest successful run per source via `sources.lastSuccessfulRunId`, updated on run completion (`runs:setStatus`).
  - [x] Track which run last saw each product via `productsLatest.lastSeenRunId` (set in `products:ingestRun`) and filter list/unlinked/counts by that run.
  - [x] (Optional) One-off backfill for existing DBs so pre-change `productsLatest` rows get `lastSeenRunId` (otherwise semantics update after the next run per source). Implemented as `adminActions:backfillProductsLatestLastSeenRunId`.
- [x] Prevent duplicate/overlapping runs per source (old: `JobQueue.is_scraper_queued_or_running`)
  - [x] Add an action guard in `new/convex/runsActions.ts` to refuse a new run if there is already a `pending`/`running` run for that `sourceSlug`.
  - [x] Reflect this in UI (disable “Run”, show “Queued/Running” state per source).
  - [x] Break up the giant App.tsx into a proper structure
  - [x] Ensure a default login password exists for local dev, still overridden by `CORASTUFF_PASSWORD` (currently `dev` via `new/.env.example` and `new/docker-compose.yml`).

## 1) Dashboard parity (`/`)

Old reference: `src/webapp/templates/dashboard.html`, `src/webapp/templates/partials/_stats.html`, `src/db.py:get_stats`, `src/db.py:get_last_scrape_times`.

- [x] Implement dashboard KPIs: canonical count, linked count, unlinked count, sources count.
  - Backed by `new/convex/dashboard.ts` (`dashboard:stats`).
- [x] Implement “Data Sources” list with last-scraped timestamp + relative “ago” display.
  - Backed by `new/convex/dashboard.ts` (`dashboard:lastScrapes`).
- [x] Ensure “Danger zone / Reset all” matches old UX (double-confirm + inline result panel).

## 2) Insights parity (`/insights`)

Old reference: `src/webapp/templates/insights.html`, `src/db.py:get_insights_snapshot`.

- [x] Port “Insights” computation into Convex (or a worker-produced snapshot):
  - [x] Persist per-product previous price + delta fields during ingest (supports movers + prices landing).
  - [x] Summary tiles: recent drops, recent spikes, stale sources, recent failures.
  - [x] Summary tiles: new extremes, outliers.
  - [x] “Last-run movers” sections (drops/spikes) (deep links TBD until `/prices/*` exists).
  - [x] New lows / new highs lists.
  - [x] “Streak trends” (sustained drops/rises).
  - [x] Cross-source outliers vs canonical median (requires canonical link graph + latest prices).
  - [x] Coverage snapshots: source coverage + canonical coverage gaps (old: `get_source_coverage_snapshot`, `get_canonical_coverage_gaps`).
  - [x] Scrape health signals: stale sources (by last scrape time) + recent failures window.
- [x] Build the Insights UI with the same information architecture and drilldowns as old.
  - [x] Add the `/insights` route + nav + MVP page (tiles + movers + scrape health).
  - [x] Add extremes + outliers sections (new lows/highs + outliers list).
  - [x] Add streak trends + coverage sections.
  - [x] Add drilldowns for streak/coverage items.
    - [x] Canonical coverage gaps link to canonical detail (`/products/:canonicalId`).
    - [x] Deep-link movers/extremes/streaks/outliers + source unlinked counts into `/link`.
    - [x] Price-history drilldowns (movers/extremes/outliers/streaks → `/prices/product/...`).

## 3) Canonical Products parity (`/products/*`)

Old reference: `src/webapp/templates/products/*`, routes in `src/webapp/routes.py`, DB ops in `src/db.py` (canonical CRUD + links).

- [x] Canonical products list page
  - [x] Search (name + description).
  - [x] Link-count badge + linked-source chips preview.
  - [x] “New Product” CTA.
- [x] Canonical create/edit form (name + optional description).
- [x] Canonical detail page
  - [x] Table of linked source products with: source, name, price, currency, item id, outbound URL.
  - [x] Highlight best price among linked sources.
  - [x] Unlink action per row with redirect back to canonical detail.
- [x] Canonical delete flow with confirmation (deletes links too).

## 4) Link Products workbench parity (`/link`)

Old reference: `src/webapp/templates/link/workbench.html`, `src/webapp/templates/link/_unlinked_list.html`, routes in `src/webapp/routes.py`, DB ops in `src/db.py` (unlinked queries, canonical search, suggestions, bulk link).

- [x] Multi-source linking workbench
  - [x] Left rail: source list with counts, filter box, “All/None”, “Show sources with 0 unlinked”.
  - [x] Show “missing IDs” warning/count per source (old: `unlinked_missing_id`).
  - [x] “Refresh counts” behavior.
- [x] Unlinked queue behavior (center column)
  - [x] Search by product name/SKU, scoped to selected sources.
  - [x] Pagination + “Load more” with offset/limit (old: `get_unlinked_products_page`).
  - [x] Row selection + keyboard/auto-advance UX (old: “Auto-advance to next item”).
  - [x] Bulk selection UI (“N selected”) + bulk-link to a canonical.
- [x] Linking panel behavior (right column)
  - [x] Canonical search/autocomplete (old: `/link/api/canonicals`).
  - [x] Suggested canonicals for the selected unlinked product (old: `/link/api/product-suggestions`).
  - [x] “Keep selected canonical for next item”.
  - [x] Create new canonical + link (pre-filled with selected product name).
  - [x] Unlink action + proper redirects.
- [x] Smart suggestions section (bottom “Review and apply bulk links”)
  - [x] Implement heuristic suggestions (token overlap + name similarity) (old: `src/db.py:get_link_suggestions`).
  - [x] UI: rescan, dismiss suggestion, apply suggested links (bulk), show reasons + scores, show preview images.
- [x] API parity for linking actions
  - [x] JSON endpoints: link existing, create+link, bulk-link multiple items (old: `/link/api/link`, `/link/api/link-new`, `/link/api/bulk-link`).
  - [x] Efficient “get unlinked by keys” query (old: `get_unlinked_products_by_keys`) to support bulk actions.

## 5) Prices parity (`/prices/*`)

Old reference: `src/webapp/templates/prices/*`, `src/db.py:get_latest_products_with_price_change`, `src/db.py:get_product_price_history`, `src/webapp/routes.py` price routes + JSON endpoints for charts.

- [x] Prices landing page
  - [x] Table view grouped by source + cards view toggle.
  - [x] Search by product name.
  - [x] Filter by source + price ranges.
  - [x] Show latest price + price-change absolute + percentage vs previous run (requires “previous scrape” computation).
  - [x] Show product image thumbnails (served as stable URLs).
  - [x] Canonical section at top: “View Prices” per canonical.
- [x] Per-product price history page
  - [x] Current price card, source chip, outbound URL.
  - [x] Chart with adaptive time unit (old: Chart.js + date adapter).
  - [x] History table with deltas vs previous point.
  - [x] “Linked to canonical” banner + link.
- [x] Canonical price comparison page
  - [x] “Current prices” grid across linked sources with best-price highlight.
  - [x] Multi-series comparison chart.
  - [x] Per-source history tables + “View full history” links.
- [x] Expose JSON/series endpoints needed for charting (implemented via Convex queries).

## 6) Amazon Pricing parity (`/amazon-pricing`)

Old reference: `src/webapp/templates/amazon/index.html`, `src/db.py:get_amazon_pricing_items`, `src/db.py:add_manual_amazon_product`.

- [x] Add data model support for Amazon listings (as sources like `amazon`/`amazon_de` in old) and/or manual ingestion.
  - Implemented manual upserts via `new/convex/amazon.ts` (`amazon:ensureAmazonSource`, `amazon:upsertManualListing`) stored in `productsLatest` + `pricePoints` without run semantics.
- [x] Compute Amazon vs retailer opportunities per canonical:
  - [x] Classify into: undercut, raise, watch, missing competitors, missing own price (and “missing Amazon” if desired).
  - [x] KPI summary: counts + total overprice + potential gain.
  - [x] Tables for each action with: canonical, Amazon price/link, cheapest retailer, gap, suggested price.
- [x] Build the Amazon Pricing UI to match the old page structure and actions.

## 7) Scrapers parity (`/scrapers/*`)

Old reference: `src/webapp/templates/scrapers/*`, `src/webapp/routes.py` scraper routes, `src/cli.py` + `src/worker.py` + `src/job_queue.py`, schedules in `src/scheduler.py`.

- [x] Scrapers overview page
  - [x] Status counts (running/queued/failed/completed/idle).
  - [x] Table of scrapers/sources with: status, last activity, products count, actions.
  - [x] Search + status filter chips.
  - [x] “Run all” action (skip already queued/running). Implemented as `runsActions:requestAll` and exposed in the current minimal Sources UI (until the scrapers page exists).
  - [x] Row auto-refresh while active (Convex subscriptions).
- [x] Scrape run history page
  - [x] KPI stats (total, successful, failed, running, success rate) + “recent failures” callout.
  - [x] Filters by scraper + status + limit.
  - [x] Table columns: started, duration, products found, error (truncate + link).
- [x] Scrape run detail page
  - [x] Status badges, started/completed/duration, products found, full error message.
  - [x] Artifact links (products.json, run.log, screenshots, html, etc if present).
  - [x] Link to “all runs for this scraper”.
- [x] “Add scraper” builder parity
  - [x] Rebuild/replace Codex-powered scraper builder flow (old: `/scrapers/builder`, `/api/scraper-builder/*`).
  - [x] Streaming logs + cancel + persistence across refresh.
  - [x] Define what “adding a scraper” means in the TS world: save a `sources` config + validate via worker dry-run (no ingest).
  - [x] (Nice-to-have) Expand auto-detection/templates (locale prefixes, non-Globetrotter Playwright recipes, etc).
  - [x] (Nice-to-have) Allow multiple saved builder drafts per user (instead of singleton `current`).

## 8) Automation / schedules parity (`/scrapers/schedules`)

Old reference: `src/webapp/templates/scrapers/schedules.html`, `src/webapp/routes.py` scheduler endpoints, `src/db.py` schedules + concurrency settings.

- [ ] Schedules UI parity
  - [ ] Global scheduler status panel (running/paused) and controls (start/stop), or a new equivalent if BullMQ scheduling is always-on.
  - [ ] Bulk enable/disable schedules.
  - [ ] Bulk set interval minutes.
  - [ ] Sticky “unsaved changes” save bar (if keeping “save-all” UX) or an explicit “saved” indicator per row.
  - [ ] Per-source schedule row: enabled toggle, interval, last run, next run.
- [ ] Concurrency limit parity
  - [ ] Persist “max concurrent scrapers” setting (old: `ProductDatabase.get_scraper_concurrency_limit`).
  - [ ] Apply it to BullMQ worker concurrency (or implement a limiter in the enqueuer/scheduler).

## 9) Source configuration management (new-only requirement for parity)

Old scrapers are code-defined; new stack is config-driven (`sources.config`).

- [ ] UI to create/edit sources (slug, displayName, type, config JSON with validation) (builder currently supports a basic “save source”).
- [ ] Validation + “test scrape” action that runs a dry-run and reports errors before enabling schedules (builder dry-run exists, needs generalization).

## 10) Scraper coverage parity (port Python scrapers → TS or decide hybrid)

- [ ] Use cheerio for extraction instead of regex where it makes sense. Migrate existing scrapers to use it and use it for new scrapers too.

Old sources exist as Python scrapers in `src/scrapers/*.py`. New TS scrapers currently cover only:
- Shopify collection JSON (`new/packages/scrapers/src/shopifyCollection.ts`)
- Shopify vendor listing (`new/packages/scrapers/src/shopifyVendorListing.ts`)
- Globetrotter brand listing (`new/packages/scrapers/src/globetrotterBrand.ts`)

Remaining old scrapers to cover (parity target):
- [ ] `amazon` (plus any Amazon DE variant used)
- [ ] `artzt`
- [ ] `bergzeit`
- [ ] `bike24`
- [ ] `bodyguard_shop`
- [ ] `bunert`
- [ ] `cardiofitness` (already partially covered via Shopify JSON, but validate parity)
- [ ] `decathlon_ch`
- [ ] `dein_vital_shop` (already partially covered via Shopify JSON, but validate parity)
- [ ] `digitec` (Playwright + stealth/UA considerations)
- [ ] `fitshop`
- [ ] `galaxus` (Playwright + stealth/UA considerations)
- [ ] `intersport`
- [ ] `kaufland`
- [ ] `keller_sports`
- [ ] `kuebler_sport`
- [ ] `manor`
- [ ] `medidor` (already partially covered via Shopify vendor listing, but validate parity)
- [ ] `migros`
- [ ] `oezpinar`
- [ ] `otto`
- [ ] `sanicare`
- [ ] `seeger24`
- [ ] `sport2000`
- [ ] `sport_bittl`
- [ ] `sport_conrad`
- [ ] `sportscheck`
- [ ] `tennis_point`
- [ ] `transa`
- [ ] `upswing`

Cross-cutting scraper parity tasks:
- [ ] Bring over per-site “browser context” knobs (UA/locale/viewport/stealth init) for protected storefronts (see repo notes in `AGENTS.md`).
- [ ] Standardize product output: stable `itemId`, `name`, `price`, `currency`, `url`, `imageUrl` (and ensure currency inference matches old behavior).
- [ ] Ensure image fetching works on bot-protected sites (headers mimicking `<img>` request).
- [ ] Add “products missing stable ID” detection and surface it in linking UI (old: `unlinked_missing_id` warnings).

## 12) Operational parity / polish

- [ ] Improve error UX: toasts, inline errors, retry buttons, empty states (match old UX quality).
- [ ] Wherever it makes sense, use fuse.js for fuzzy matching and search.
- [ ] Make global Spotlight search real: search canonicals/products/sources (not just nav/actions), jump directly to /products/:id, /prices/
    product/:sourceSlug/:itemId, /scrapers/history/:runId.
- [ ] Bulk workflows everywhere: bulk enable/disable sources, bulk schedule edits, bulk relink/unlink, bulk “open in new tabs” actions for
    retailer/Amazon.
- [ ] Worker robustness: add timeouts + retry policy for fetches, and classify failures (blocked/timeout/parse) so UI can suggest “switch to
    Playwright/stealth/headers” automatically.
- [ ] Automated linking suggestions: upgrade token-based matching to fuzzy (Fuse.js per TODO) plus price-band + vendor/domain heuristics,
    with “suggest + accept all” flows and confidence thresholds.
