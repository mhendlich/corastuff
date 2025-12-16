## Scraper learnings (general)

- For Bunny Shield / bot-protected sites, use a realistic desktop `user_agent`, set `locale`, and add a small `context.add_init_script(...)` to hide `navigator.webdriver` (works well in headless Playwright).
- Some sites return an HTML challenge page when fetching images via `page.context.request.get(...)`; mimic a real `<img>` request by sending headers like `Accept: image/*`, `Referer`, and `Sec-Fetch-Dest: image` to get the actual bytes.
- Prefer adding optional per-scraper context settings (UA/locale/viewport/init scripts) to `src/scrapers/browser_pool.py` so individual scrapers can opt-in without affecting others.
- Some Next.js storefronts expose full product listings in `script#__NEXT_DATA__`; parsing that JSON is often more stable than relying on CSS selectors, and pagination can commonly be driven via `count`/`offset` query params found in the rendered HTML.
- Some ecommerce sites embed product metadata (name/id/price/currency) in `window.dataLayer` (GTM); `page.evaluate(() => window.dataLayer)` is often more stable than CSS selectors for PDPs.
- For Shopify sites, try the collection JSON endpoint `.../collections/<handle>/products.json?limit=250&page=N` to get stable product+image URLs without browser automation.
- For Shopify collection URLs that look like `.../collections/<handle>/<tag>`, the collection JSON endpoint is still typically `.../collections/<handle>/products.json` (tag filtering may require `constraint=<tag>`).
- Shopify `products.json` often omits currency; infer from storefront (e.g. `Shopify.currency.active`) or configure per-scraper default.
- For Shopify sites, sanity-check that the target brand actually exists in the current storefront (e.g. `.../search?type=product&q=<brand>` or scan `.../products.json?limit=250&page=N` for matching `vendor`/`title`); some stores keep brand/collection pages published but empty, which makes live “must save products+images” tests impossible.
- For Shopware 5 storefronts, search/listing pages often include stable product IDs in `div.product--box[data-ordernumber]` plus GTM `window.dataLayer` `ecommerce.impressions` (name/id/price/currency) and `img[srcset]` for images (prefer the last/highest-res candidate).
- Some Cloudflare-protected storefront pages return `403` for plain HTTP clients (curl/requests) but load fine in Playwright; treat browser automation as the HTML-fetch layer, then parse the rendered DOM.
- In this repo, run live scraper tests with `./venv/bin/python -m pytest ...` (system `python3` may not have `pytest` installed).
- If Playwright Chromium hits `net::ERR_HTTP2_PROTOCOL_ERROR` on a site, try Playwright Firefox; in this repo you can set `browser_type = "firefox"` on a scraper (supported by `src/scrapers/browser_pool.py`).
- For Digitec/Galaxus storefront pages, using a realistic desktop `user_agent` plus a small stealth init script (hide `navigator.webdriver`, set `navigator.languages` and `navigator.plugins`) can be required for the product-list GraphQL/Relay requests to succeed in headless runs.
- For Shopify `.../products.json` endpoints, `products[].images` is often a list of image objects; prefer `images[0].src` (don’t assume it’s a list of strings).
- Some Shopify vendor pages (`/collections/vendors?q=<vendor>`) don’t expose a working `.../collections/vendors/products.json`; scrape product handles from the rendered vendor listing and then fetch each product via `.../products/<handle>.json` (stable title/variants/images).
- Cookie-consent overlays (e.g. Didomi) can include “More info” buttons (like `Weitere Informationen`) that accidentally match naive “load more” selectors; scope “load more” lookups to the product grid/container or use more specific attributes.
