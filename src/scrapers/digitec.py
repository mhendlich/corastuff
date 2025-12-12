"""Scraper for Digitec.ch Blackroll brand pages."""

from __future__ import annotations

import re
from datetime import UTC, datetime
from urllib.parse import urljoin

from playwright.async_api import Page

from ..models import Product, ScrapeResult
from ..utils import parse_price
from .base import BaseScraper
from .browser_pool import get_browser_context


_DESKTOP_UA = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"
)

_STEALTH_INIT_SCRIPT = """
Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] });
Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] });
""".strip()


class DigitecScraper(BaseScraper):
    name = "digitec_ch"
    display_name = "Digitec.ch"
    url = "https://www.digitec.ch/en/brand/blackroll-11375"

    browser_type = "firefox"
    user_agent = _DESKTOP_UA
    locale = "en-CH"
    viewport = {"width": 1920, "height": 1080}
    init_scripts = [_STEALTH_INIT_SCRIPT]

    _base_url = "https://www.digitec.ch"

    async def scrape(self) -> ScrapeResult:
        async with get_browser_context(
            browser_type=self.browser_type,
            user_agent=self.user_agent,
            locale=self.locale,
            viewport=self.viewport,
            init_scripts=self.init_scripts,
        ) as context:
            page = await context.new_page()
            print(f"[{self.name}] Loading {self.url}...")
            await page.goto(self.url, wait_until="domcontentloaded", timeout=90000)
            await self._handle_cookie_consent(page)
            await page.wait_for_timeout(1200)

            listing_urls = await self._extract_listing_urls(page)
            if not listing_urls:
                listing_urls = [self.url]

            products: list[Product] = []
            for idx, listing_url in enumerate(listing_urls):
                print(f"[{self.name}] Loading listing {idx + 1}/{len(listing_urls)}: {listing_url}")
                await page.goto(listing_url, wait_until="domcontentloaded", timeout=90000)
                await self._handle_cookie_consent(page)
                await self._wait_for_products(page)
                await self._load_all_products(page)
                products.extend(await self.extract_products(page))

        deduped: dict[str, Product] = {}
        for product in products:
            key = product.item_id or product.url or product.name
            if not key:
                continue
            deduped[key] = product

        final_products = list(deduped.values())
        print(f"[{self.name}] Extracted {len(final_products)} products")

        return ScrapeResult(
            source=self.name,
            source_url=self.url,
            scraped_at=datetime.now(UTC),
            products=final_products,
        )

    @staticmethod
    def _extract_brand_id_from_url(url: str) -> str | None:
        if not url:
            return None
        if match := re.search(r"-(\d{3,})/?$", url):
            return match.group(1)
        return None

    async def _extract_listing_urls(self, page: Page) -> list[str]:
        brand_id = self._extract_brand_id_from_url(self.url)
        if not brand_id:
            return []

        hrefs = await page.eval_on_selector_all(
            "a[href]",
            "els => els.map(a => a.getAttribute('href')).filter(Boolean)",
        )
        if not isinstance(hrefs, list):
            return []

        wanted = f"filter=bra%3D{brand_id}"
        urls: list[str] = []
        seen: set[str] = set()
        for href in hrefs:
            if not isinstance(href, str):
                continue
            h = href.strip()
            if not h:
                continue
            if "/producttype/" not in h:
                continue
            if wanted not in h:
                continue
            absolute = urljoin(self._base_url, h)
            if absolute in seen:
                continue
            seen.add(absolute)
            urls.append(absolute)
        return urls

    async def _handle_cookie_consent(self, page: Page) -> None:
        for selector in [
            'button:has-text("Accept all")',
            'button:has-text("Accept")',
            'button:has-text("Alle akzeptieren")',
            'button:has-text("Allem zustimmen")',
            "#onetrust-accept-btn-handler",
            '[data-testid="uc-accept-all-button"]',
        ]:
            try:
                btn = await page.query_selector(selector)
                if btn and await btn.is_visible():
                    await btn.click()
                    await page.wait_for_timeout(700)
                    return
            except Exception:
                continue

    async def _wait_for_products(self, page: Page) -> None:
        try:
            await page.wait_for_selector('article a[href*="/product/"]', timeout=60000, state="attached")
        except Exception:
            # Some listings can be empty; let extraction handle it.
            return

    async def _load_all_products(self, page: Page) -> None:
        stable_rounds = 0
        last_count = -1
        for _ in range(12):
            try:
                count = await page.locator('article a[href*="/product/"]').count()
            except Exception:
                count = 0

            if count == last_count:
                stable_rounds += 1
            else:
                stable_rounds = 0
            last_count = count
            if stable_rounds >= 2:
                return

            for selector in [
                'button:has-text("Show more")',
                'button:has-text("Load more")',
                'button:has-text("More")',
                'button:has-text("Mehr anzeigen")',
            ]:
                try:
                    btn = await page.query_selector(selector)
                    if btn and await btn.is_visible():
                        await btn.click()
                        await page.wait_for_timeout(1000)
                        break
                except Exception:
                    continue

            try:
                await page.evaluate("() => window.scrollTo(0, document.body.scrollHeight)")
            except Exception:
                pass
            await page.wait_for_timeout(1100)

    @staticmethod
    def _pick_best_srcset_url(srcset: str | None) -> str | None:
        if not srcset or not isinstance(srcset, str):
            return None
        candidates = [p.strip() for p in srcset.split(",") if p.strip()]
        if not candidates:
            return None
        # Prefer browser-friendly formats (Pillow cannot reliably decode AVIF in this repo).
        urls = [c.split()[0].strip() for c in candidates if c.split() and c.split()[0].strip()]
        for ext in (".webp", ".jpeg", ".jpg", ".png"):
            for u in reversed(urls):
                if ext in u.lower():
                    return u
        return urls[-1] if urls else None

    async def _fetch_image(self, page: Page, image_url: str | None) -> tuple[bytes | None, str | None]:
        if not image_url or not isinstance(image_url, str):
            return None, None

        image_url = image_url.strip()
        if not image_url:
            return None, None

        if image_url.startswith("//"):
            image_url = f"https:{image_url}"
        elif image_url.startswith("/"):
            image_url = urljoin(self._base_url, image_url)

        try:
            resp = await page.context.request.get(
                image_url,
                headers={
                    "Accept": "image/avif,image/webp,image/apng,image/*,*/*;q=0.8",
                    "Referer": page.url,
                    "Sec-Fetch-Dest": "image",
                    "Sec-Fetch-Mode": "no-cors",
                    "Sec-Fetch-Site": "cross-site",
                },
                timeout=45000,
            )
            if not resp.ok:
                return None, None
            body = await resp.body()
            if len(body) < 800:
                return None, None
            mime = resp.headers.get("content-type")
            if mime and ";" in mime:
                mime = mime.split(";", 1)[0].strip()
            return body, mime
        except Exception as img_err:
            print(f"[{self.name}] Failed to fetch image: {img_err}")
            return None, None

    async def extract_products(self, page: Page) -> list[Product]:
        products: list[Product] = []

        articles = await page.query_selector_all("article")
        for idx, article in enumerate(articles):
            try:
                link = await article.query_selector('a[href*="/product/"]')
                if not link:
                    continue

                name = await link.get_attribute("aria-label")
                if not name:
                    continue
                name = name.replace("\xa0", " ").strip()

                href = await link.get_attribute("href")
                url = urljoin(self._base_url, href) if href else None

                item_id = None
                if url and (match := re.search(r"-(\d{6,})(?:\\?|$|/|#)", url)):
                    item_id = match.group(1)

                text = await article.inner_text()
                price, currency = parse_price(" ".join(text.split()))

                img_url = None
                img_el = await article.query_selector("picture img") or await article.query_selector("img")
                if img_el:
                    img_url = (
                        await img_el.get_attribute("src")
                        or await img_el.get_attribute("data-src")
                        or self._pick_best_srcset_url(await img_el.get_attribute("srcset"))
                        or self._pick_best_srcset_url(await img_el.get_attribute("data-srcset"))
                    )

                if not img_url:
                    source_el = await article.query_selector("picture source[srcset]")
                    if source_el:
                        img_url = self._pick_best_srcset_url(await source_el.get_attribute("srcset"))

                image_bytes, image_mime = await self._fetch_image(page, img_url)

                products.append(
                    Product(
                        name=name,
                        price=price,
                        currency=currency,
                        url=url,
                        item_id=item_id,
                        image=image_bytes,
                        image_mime=image_mime,
                    )
                )
            except Exception as exc:
                print(f"[{self.name}] Error extracting product {idx}: {exc}")
                continue

        return products

