"""Scraper for official Amazon.de Blackroll store products.

Amazon pages are dynamic and occasionally protected. This scraper uses Playwright
with stealth, scrolls the storefront to load all items, and extracts ASINs,
titles, prices, URLs, and images.
"""

from __future__ import annotations

import random
import re
import html as htmllib
from datetime import datetime, UTC
from urllib.parse import urljoin

from playwright.async_api import Page, BrowserContext, async_playwright
from playwright_stealth import Stealth

from ..models import Product, ScrapeResult
from ..utils import parse_price
from .base import BaseScraper

AMAZON_BASE = "https://www.amazon.de"

COOKIE_SELECTORS = [
    "#sp-cc-accept",
    "input#sp-cc-accept",
    'button:has-text("Alle Cookies akzeptieren")',
    'button:has-text("Alle akzeptieren")',
    'button:has-text("Zustimmen")',
]

DETAIL_PRICE_SELECTORS = [
    "#corePrice_feature_div .a-price .a-offscreen",
    "#corePriceDisplay_desktop_feature_div .a-price .a-offscreen",
    "#apex_desktop .a-price .a-offscreen",
    ".a-price .a-offscreen",
    "#priceblock_ourprice",
    "#priceblock_dealprice",
    "#price_inside_buybox",
    "#newBuyBoxPrice",
]


class AmazonDEScraper(BaseScraper):
    """Scrape Blackroll products from the official Amazon.de storefront."""

    name = "amazon_de"
    display_name = "Amazon.de (Official)"
    url = (
        "https://www.amazon.de/stores/page/03098AB4-BDD5-4A23-A7DD-5C10153C5D58"
        "?ingress=2&lp_context_asin=B00EQ4PZHY&lp_context_query=blackroll"
        "&store_ref=bl_ast_dp_brandLogo_sto&ref_=ast_bln"
    )

    async def scrape(self) -> ScrapeResult:
        """Run the scraper with Amazon-specific handling."""
        async with async_playwright() as p:
            browser = await p.chromium.launch(
                headless=True,
                args=[
                    "--disable-blink-features=AutomationControlled",
                    "--no-sandbox",
                ],
            )
            context = await browser.new_context(
                viewport={"width": 1920, "height": 1080},
                locale="de-DE",
                user_agent=(
                    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 "
                    "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"
                ),
            )
            page = await context.new_page()
            stealth = Stealth()
            await stealth.apply_stealth_async(page)

            print(f"[{self.name}] Loading {self.url}...")
            try:
                await page.goto(self.url, wait_until="domcontentloaded", timeout=90000)
            except Exception as e:
                print(f"[{self.name}] Initial load error: {e}, continuing...")

            await self._handle_cookie_consent(page)

            content = await page.content()
            lowered = content.lower()
            if "robot check" in content or "captcha" in lowered or "geben sie die zeichen" in lowered:
                print(f"[{self.name}] Blocked by Amazon (captcha/robot check).")
                await browser.close()
                return ScrapeResult(
                    source=self.name,
                    source_url=self.url,
                    scraped_at=datetime.now(UTC),
                    products=[],
                )

            store_pages = await self._discover_store_subpages(page)
            current_url = page.url or self.url
            current_guid = None
            if m := re.search(r"/stores/(?:[^/]+/)?page/([A-F0-9-]{36})", current_url, re.I):
                current_guid = m.group(1)

            if store_pages and current_guid:
                discovered_guids = {
                    m.group(1)
                    for u in store_pages
                    if (m := re.search(r"/stores/(?:[^/]+/)?page/([A-F0-9-]{36})", u, re.I))
                }
                if current_guid not in discovered_guids:
                    store_pages.insert(0, current_url)
            elif not store_pages:
                store_pages = [current_url]

            all_products: list[Product] = []
            print(f"[{self.name}] Discovered {len(store_pages)} store page(s)")
            for idx, url in enumerate(store_pages, 1):
                print(f"[{self.name}] Scraping store page {idx}/{len(store_pages)}: {url}")
                try:
                    if url != page.url:
                        await page.goto(url, wait_until="domcontentloaded", timeout=90000)
                        await self._handle_cookie_consent(page)
                except Exception as e:
                    print(f"[{self.name}] Store page load error: {e}, skipping {url}")
                    continue

                await self._scroll_to_load_all(page)
                page_products = await self.extract_products(page)
                all_products.extend(page_products)
                await page.wait_for_timeout(800 + random.randint(0, 1200))

            products = self._dedupe_products(all_products)
            print(f"[{self.name}] Extracted {len(products)} products total")

            missing_prices = [p for p in products if p.price is None]
            if missing_prices:
                products = await self._enrich_with_detail_prices(context, products)
                print(
                    f"[{self.name}] Enriched prices for {len(missing_prices)} missing product(s)"
                )

            await browser.close()

        return ScrapeResult(
            source=self.name,
            source_url=self.url,
            scraped_at=datetime.now(UTC),
            products=products,
        )

    async def _handle_cookie_consent(self, page: Page) -> None:
        """Handle Amazon cookie consent banners if present."""
        for selector in COOKIE_SELECTORS:
            try:
                btn = await page.query_selector(selector)
                if btn and await btn.is_visible():
                    print(f"[{self.name}] Accepting cookies...")
                    await btn.click()
                    await page.wait_for_timeout(1000)
                    return
            except Exception:
                continue

    async def _scroll_to_load_all(self, page: Page, max_rounds: int = 20) -> None:
        """Scroll through the storefront to trigger lazy loading."""
        seen_asins: set[str] = set()
        stagnant_rounds = 0

        for _ in range(max_rounds):
            await page.wait_for_timeout(1500 + random.randint(0, 800))

            current_asins = await self._collect_asins(page)
            new_asins = current_asins - seen_asins

            if not new_asins:
                stagnant_rounds += 1
            else:
                stagnant_rounds = 0
                seen_asins |= new_asins

            if stagnant_rounds >= 2:
                break

            await self._click_see_more(page)
            await page.evaluate("window.scrollTo(0, document.body.scrollHeight)")

        print(f"[{self.name}] Loaded ~{len(seen_asins)} ASINs after scrolling")

    async def _click_see_more(self, page: Page) -> None:
        """Click 'see more' buttons if present to expand modules."""
        for selector in [
            'button:has-text("Mehr anzeigen")',
            'a:has-text("Mehr anzeigen")',
            'button:has-text("See more")',
            'a:has-text("See more")',
        ]:
            try:
                btn = await page.query_selector(selector)
                if btn and await btn.is_visible():
                    await btn.click()
                    await page.wait_for_timeout(1000)
                    return
            except Exception:
                continue

    async def _collect_asins(self, page: Page) -> set[str]:
        """Collect ASINs from data-asin attributes and /dp/ links."""
        asins: set[str] = set()

        for el in await page.query_selector_all("[data-asin]"):
            asin = ((await el.get_attribute("data-asin")) or "").strip()
            if re.fullmatch(r"[A-Z0-9]{10}", asin):
                asins.add(asin)

        if not asins:
            for link in await page.query_selector_all('a[href*="/dp/"], a[href*="/gp/product/"]'):
                href = await link.get_attribute("href")
                if not href:
                    continue
                if m := re.search(r"/(?:dp|gp/product)/([A-Z0-9]{10})", href):
                    asins.add(m.group(1))

        return asins

    async def _discover_store_subpages(self, page: Page, max_pages: int = 20) -> list[str]:
        """Discover Blackroll store subpages (categories/tabs) from the storefront home.

        Amazon brand stores often render products only on subpages reachable via
        /stores/page/<GUID> links. We extract those and follow them.
        """
        attempts = 3
        for attempt in range(attempts):
            try:
                hrefs = await page.evaluate(
                    "() => Array.from(document.querySelectorAll('a[href]'))"
                    ".map(a => a.getAttribute('href')).filter(Boolean)"
                )
            except Exception:
                hrefs = []

            candidates: list[str] = []
            filtered: list[str] = []
            seen_guids: set[str] = set()

            for raw in hrefs:
                href = htmllib.unescape(raw)
                lower = href.lower()
                if "/stores/page/" not in lower and "/stores/" not in lower:
                    continue
                # Exclude obvious top-nav/other-brand store links.
                if any(
                    bad in lower
                    for bad in [
                        "ref_=nav_",
                        "nav_cs_",
                        "field-lbr_brands_browse-bin=",
                        "amazonbasics",
                    ]
                ):
                    continue

                if href.startswith("//"):
                    href = f"https:{href}"
                elif href.startswith("/"):
                    href = urljoin(AMAZON_BASE, href)

                m = re.search(r"/stores/(?:[^/]+/)?page/([A-F0-9-]{36})", href, re.I)
                if not m:
                    continue
                guid = m.group(1)
                if guid in seen_guids:
                    continue

                seen_guids.add(guid)
                candidates.append(href)

                if "blackroll" in lower or "ref_=ast" in lower or "store_ref=bl_ast" in lower:
                    filtered.append(href)

                if len(candidates) >= max_pages:
                    break

            if filtered:
                return filtered
            if candidates and attempt == attempts - 1:
                return candidates

            # Trigger lazy modules that may contain store-page links.
            try:
                await page.evaluate("window.scrollTo(0, document.body.scrollHeight)")
            except Exception:
                pass
            await page.wait_for_timeout(1500 + random.randint(0, 1200))

        return []

    async def _is_blocked(self, page: Page) -> bool:
        """Detect Amazon captcha/robot check pages."""
        try:
            content = (await page.content()).lower()
        except Exception:
            return False
        return (
            "robot check" in content
            or "captcha" in content
            or "geben sie die zeichen" in content
        )

    async def _get_detail_price_text(self, page: Page) -> str | None:
        """Extract raw price text from a product detail page."""
        for sel in DETAIL_PRICE_SELECTORS:
            try:
                el = await page.query_selector(sel)
            except Exception:
                el = None
            if el:
                try:
                    text = (await el.inner_text()).strip()
                except Exception:
                    text = None
                if text:
                    return text
        return None

    async def _enrich_with_detail_prices(
        self,
        context: BrowserContext,
        products: list[Product],
    ) -> list[Product]:
        """Open each product page and refresh price/currency."""
        targets = [p for p in products if p.price is None]
        if not targets:
            return products

        detail_page = await context.new_page()
        stealth = Stealth()
        await stealth.apply_stealth_async(detail_page)

        for i, product in enumerate(targets, 1):
            asin = (product.item_id or "").strip().upper()
            detail_url = (
                f"{AMAZON_BASE}/dp/{asin}" if re.fullmatch(r"[A-Z0-9]{10}", asin) else product.url
            )
            if not detail_url:
                continue

            try:
                await detail_page.goto(detail_url, wait_until="domcontentloaded", timeout=90000)
            except Exception as e:
                print(f"[{self.name}] Detail page load error for {asin or detail_url}: {e}")
                continue

            await self._handle_cookie_consent(detail_page)

            if await self._is_blocked(detail_page):
                print(f"[{self.name}] Blocked while scraping detail pages; stopping enrichment.")
                break

            price_text = await self._get_detail_price_text(detail_page)
            price, currency = parse_price(price_text) if price_text else (None, None)

            if price is not None:
                product.price = price
                if currency is not None:
                    product.currency = currency
                elif product.currency is None:
                    product.currency = "EUR"

            await detail_page.wait_for_timeout(500 + random.randint(0, 900))
            if i % 8 == 0:
                await detail_page.wait_for_timeout(1200 + random.randint(0, 1600))

        await detail_page.close()
        return products

    async def extract_products(self, page: Page) -> list[Product]:
        """Extract product data from the current page state."""
        products: list[Product] = []

        # Prefer explicit product nodes.
        candidates = await page.query_selector_all("[data-asin]")
        if not candidates:
            candidates = await page.query_selector_all('a[href*="/dp/"], a[href*="/gp/product/"]')

        for idx, cand in enumerate(candidates):
            try:
                container = cand
                if (await cand.get_attribute("data-asin")) is None:
                    # If the candidate is a link, climb to a reasonable container.
                    container = await cand.evaluate_handle(
                        "el => el.closest('[data-asin]') || el.closest('div') || el"
                    )

                asin = ((await container.get_attribute("data-asin")) or "").strip()

                link = await container.query_selector('a[href*="/dp/"], a[href*="/gp/product/"]')
                if not link:
                    # Candidate might already be a link.
                    link = cand if await cand.get_attribute("href") else None
                if not link:
                    continue

                href = await link.get_attribute("href")
                if not href:
                    continue

                if not asin or not re.fullmatch(r"[A-Z0-9]{10}", asin):
                    if m := re.search(r"/(?:dp|gp/product)/([A-Z0-9]{10})", href):
                        asin = m.group(1)
                    else:
                        continue

                url = href
                if url.startswith("//"):
                    url = f"https:{url}"
                elif url.startswith("/"):
                    url = urljoin(AMAZON_BASE, url)

                name = (await link.get_attribute("aria-label")) or None
                if not name:
                    try:
                        name = (await link.inner_text()).strip()
                    except Exception:
                        name = None

                if not name:
                    for sel in [
                        "h2 span",
                        "span.a-size-base-plus",
                        "span.a-size-medium",
                        'span[role="heading"]',
                    ]:
                        el = await container.query_selector(sel)
                        if el:
                            name = (await el.inner_text()).strip()
                            if name:
                                break

                if not name:
                    continue

                name = name.replace("\xa0", " ").strip()

                price_text = None
                for sel in [
                    ".a-price .a-offscreen",
                    "span[data-a-color='price'] .a-offscreen",
                    "span.a-price-whole",
                ]:
                    el = await container.query_selector(sel)
                    if el:
                        price_text = (await el.inner_text()).strip()
                        if price_text:
                            break

                price, currency = parse_price(price_text) if price_text else (None, None)
                if price is not None and currency is None:
                    currency = "EUR"

                image_bytes = None
                image_mime = None
                image_url = None

                img_el = await container.query_selector("img")
                if img_el:
                    image_url = (
                        await img_el.get_attribute("src")
                        or await img_el.get_attribute("data-src")
                    )
                    if image_url and not image_url.startswith("data:image"):
                        if image_url.startswith("//"):
                            image_url = f"https:{image_url}"
                        elif image_url.startswith("/"):
                            image_url = urljoin(AMAZON_BASE, image_url)

                        try:
                            resp = await page.context.request.get(image_url)
                            if resp.ok:
                                image_bytes = await resp.body()
                                image_mime = resp.headers.get("content-type")
                                if image_mime and ";" in image_mime:
                                    image_mime = image_mime.split(";", 1)[0].strip()
                        except Exception as img_err:
                            print(f"[{self.name}] Failed to fetch image for {asin}: {img_err}")

                products.append(
                    Product(
                        name=name,
                        price=price,
                        currency=currency,
                        url=url,
                        item_id=asin,
                        image=image_bytes,
                        image_mime=image_mime,
                    )
                )

            except Exception as e:
                print(f"[{self.name}] Error extracting product {idx}: {e}")

        return self._dedupe_products(products)

    def _dedupe_products(self, products: list[Product]) -> list[Product]:
        """Deduplicate products by ASIN/URL/name, preferring priced entries."""
        deduped: dict[str, Product] = {}
        for p in products:
            key = p.item_id or p.url or p.name
            if not key:
                continue
            existing = deduped.get(key)
            if not existing:
                deduped[key] = p
            elif existing.price is None and p.price is not None:
                deduped[key] = p
            elif (
                existing.price is not None
                and p.price is not None
                and p.price < existing.price
            ):
                deduped[key] = p

        return list(deduped.values())


async def scrape_amazon_listing(asin: str, url: str | None = None) -> Product | None:
    """Scrape a single Amazon listing page by ASIN/URL.

    Used for manual fallback: user supplies only the listing URL/ASIN, never a price.
    Returns a Product snapshot or None if blocked/unavailable.
    """
    asin_clean = (asin or "").strip().upper()
    if not re.fullmatch(r"[A-Z0-9]{10}", asin_clean):
        return None

    listing_url = url or f"{AMAZON_BASE}/dp/{asin_clean}"

    async with async_playwright() as p:
        browser = await p.chromium.launch(
            headless=True,
            args=[
                "--disable-blink-features=AutomationControlled",
                "--no-sandbox",
            ],
        )
        context = await browser.new_context(
            viewport={"width": 1920, "height": 1080},
            locale="de-DE",
            user_agent=(
                "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 "
                "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"
            ),
        )
        page = await context.new_page()
        stealth = Stealth()
        await stealth.apply_stealth_async(page)

        try:
            await page.goto(listing_url, wait_until="domcontentloaded", timeout=90000)
        except Exception:
            await browser.close()
            return None

        # Cookie banner
        for selector in COOKIE_SELECTORS:
            try:
                btn = await page.query_selector(selector)
                if btn and await btn.is_visible():
                    await btn.click()
                    await page.wait_for_timeout(800)
                    break
            except Exception:
                continue

        content = await page.content()
        lowered = content.lower()
        if "robot check" in content or "captcha" in lowered or "geben sie die zeichen" in lowered:
            await browser.close()
            return None

        name = None
        for sel in [
            "#productTitle",
            "h1#title span",
            "h1 span#productTitle",
        ]:
            el = await page.query_selector(sel)
            if el:
                name = (await el.inner_text()).strip()
                if name:
                    break

        price_text = None
        for sel in DETAIL_PRICE_SELECTORS:
            el = await page.query_selector(sel)
            if el:
                price_text = (await el.inner_text()).strip()
                if price_text:
                    break

        price, currency = parse_price(price_text) if price_text else (None, None)
        if price is not None and currency is None:
            currency = "EUR"

        image_bytes = None
        image_mime = None
        image_url = None

        for sel in [
            "img#landingImage",
            "#imgTagWrapperId img",
        ]:
            el = await page.query_selector(sel)
            if el:
                image_url = (
                    await el.get_attribute("src")
                    or await el.get_attribute("data-old-hires")
                    or await el.get_attribute("data-a-dynamic-image")
                )
                if image_url:
                    break

        if image_url:
            if image_url.startswith("//"):
                image_url = f"https:{image_url}"
            elif image_url.startswith("/"):
                image_url = urljoin(AMAZON_BASE, image_url)

            try:
                resp = await page.context.request.get(image_url)
                if resp.ok:
                    image_bytes = await resp.body()
                    image_mime = resp.headers.get("content-type")
                    if image_mime and ";" in image_mime:
                        image_mime = image_mime.split(";", 1)[0].strip()
            except Exception:
                pass

        await browser.close()

    if not name:
        name = asin_clean

    return Product(
        name=name,
        price=price,
        currency=currency,
        url=listing_url,
        item_id=asin_clean,
        image=image_bytes,
        image_mime=image_mime,
    )
