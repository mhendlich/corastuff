"""Scraper for tennis-point.de product pages."""

from __future__ import annotations

from datetime import datetime, UTC
from urllib.parse import urlparse

from playwright.async_api import Page

from ..models import Product
from ..utils import parse_price
from .base import BaseScraper
from .browser_pool import get_browser_context
from ..models import ScrapeResult


class TennisPointScraper(BaseScraper):
    """Scrape a product from tennis-point.de."""

    name = "tennis_point"
    display_name = "Tennis-Point"
    url = "https://www.tennis-point.de/blackroll-261744.html"

    async def scrape(self) -> ScrapeResult:
        # tennis-point pages keep long-polling; networkidle often times out.
        async with get_browser_context() as context:
            page = await context.new_page()
            print(f"[{self.name}] Loading {self.url}...")
            await page.goto(self.url, wait_until="domcontentloaded", timeout=90000)
            await self._handle_cookie_consent(page)

            products = await self.extract_products(page)
            print(f"[{self.name}] Extracted {len(products)} products")

        return ScrapeResult(
            source=self.name,
            source_url=self.url,
            scraped_at=datetime.now(UTC),
            products=products,
        )

    async def _handle_cookie_consent(self, page: Page) -> None:
        for selector in [
            "#onetrust-accept-btn-handler",
            'button:has-text("Alle akzeptieren")',
            'button:has-text("Akzeptieren")',
            '[data-testid="uc-accept-all-button"]',
            "button.cc-btn.cc-allow",
            "button#acceptAllButton",
        ]:
            try:
                btn = await page.query_selector(selector)
                if btn and await btn.is_visible():
                    await btn.click()
                    await page.wait_for_timeout(800)
                    return
            except Exception:
                continue

    @staticmethod
    def _extract_item_id(url: str) -> str | None:
        try:
            path = urlparse(url).path
        except Exception:
            path = url
        slug = path.rsplit("/", 1)[-1]
        if slug.endswith(".html"):
            slug = slug[:-5]
        # Most tennis-point PDP URLs end with "-<id>.html"
        if "-" in slug:
            tail = slug.split("-")[-1].strip()
            return tail or None
        return slug.strip() or None

    async def _fetch_image(self, page: Page, image_url: str | None) -> tuple[bytes | None, str | None]:
        if not image_url:
            return None, None
        try:
            resp = await page.context.request.get(image_url, timeout=30000)
            if not resp.ok:
                return None, None
            body = await resp.body()
            if len(body) < 800:
                return None, None
            mime = resp.headers.get("content-type")
            if mime and ";" in mime:
                mime = mime.split(";", 1)[0].strip()
            return body, mime
        except Exception:
            return None, None

    async def extract_products(self, page: Page) -> list[Product]:
        await page.wait_for_selector("h1", timeout=30000)

        # Image is present in the rendered DOM as microdata.
        try:
            await page.wait_for_selector('img[itemprop="image"]', timeout=30000)
        except Exception:
            pass

        raw_h1 = (await page.text_content("h1")) or ""
        name = " ".join(raw_h1.split()).strip()

        price = None
        currency = None

        # Prefer visible price string, then fall back to microdata content.
        price_text = None
        try:
            if el := await page.query_selector(".js-price-info .real-price"):
                price_text = (await el.inner_text()).strip() or None
        except Exception:
            price_text = None

        price, currency = parse_price(price_text)

        if currency is None:
            try:
                if el := await page.query_selector('[itemprop="priceCurrency"]'):
                    curr = (await el.get_attribute("content")) or ""
                    curr = curr.strip() or None
                    currency = curr
            except Exception:
                pass

        if price is None:
            try:
                if el := await page.query_selector('[itemprop="price"]'):
                    raw = (await el.get_attribute("content")) or ""
                    raw = raw.strip()
                    if raw and raw.lower() != "null":
                        price = float(raw)
            except Exception:
                pass

        image_url = None
        try:
            if img := await page.query_selector('img[itemprop="image"]'):
                image_url = (
                    await img.get_attribute("src")
                    or await img.get_attribute("data-src")
                    or await img.get_attribute("srcset")
                    or await img.get_attribute("data-srcset")
                )
                if image_url and "," in image_url:
                    image_url = image_url.split(",")[0].split()[0]
        except Exception:
            image_url = None

        image_bytes, image_mime = await self._fetch_image(page, image_url)

        product_url = page.url
        item_id = self._extract_item_id(product_url)

        if not name:
            return []

        return [
            Product(
                name=name,
                price=price,
                currency=currency,
                url=product_url,
                item_id=item_id,
                image=image_bytes,
                image_mime=image_mime,
            )
        ]
