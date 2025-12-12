"""Scraper for Sanicare.de product page."""

from __future__ import annotations

import re
from datetime import UTC, datetime
from urllib.parse import urlparse

from playwright.async_api import Page

from ..models import Product, ScrapeResult
from ..utils import parse_price
from .base import BaseScraper
from .browser_pool import get_browser_context


class SanicareScraper(BaseScraper):
    """Scrape a Sanicare product page (currently the Blackroll DuoBall item)."""

    name = "sanicare"
    display_name = "Sanicare"
    url = "https://www.sanicare.de/p/blackroll-duoball-8cm-durchmesser-1-80145215"

    async def scrape(self) -> ScrapeResult:
        async with get_browser_context() as context:
            page = await context.new_page()

            print(f"[{self.name}] Loading {self.url}...")
            await page.goto(self.url, wait_until="domcontentloaded", timeout=90000)
            await page.wait_for_timeout(1000)

            products = await self.extract_products(page)
            print(f"[{self.name}] Extracted {len(products)} products")

        return ScrapeResult(
            source=self.name,
            source_url=self.url,
            scraped_at=datetime.now(UTC),
            products=products,
        )

    @staticmethod
    def _extract_item_id(url: str | None) -> str | None:
        if not url:
            return None
        try:
            path = urlparse(url).path.rstrip("/")
        except Exception:
            path = url.rstrip("/")
        if match := re.search(r"-(\d{5,})$", path):
            return match.group(1)
        if match := re.search(r"(\d{5,})", path):
            return match.group(1)
        return None

    async def _extract_image(self, page: Page) -> tuple[bytes | None, str | None]:
        img_el = await page.query_selector(".product-detail-media img") or await page.query_selector(
            ".gallery-slider-image"
        )
        if not img_el:
            return None, None

        image_url = (
            await img_el.get_attribute("src")
            or await img_el.get_attribute("data-src")
            or await img_el.get_attribute("data-srcset")
            or await img_el.get_attribute("srcset")
        )
        if not image_url:
            return None, None

        if "," in image_url:
            image_url = image_url.split(",")[0].split()[0]

        if image_url.startswith("//"):
            image_url = f"https:{image_url}"
        elif image_url.startswith("/"):
            image_url = f"https://www.sanicare.de{image_url}"

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
        except Exception as img_err:
            print(f"[{self.name}] Failed to fetch product image: {img_err}")
            return None, None

    async def extract_products(self, page: Page) -> list[Product]:
        await page.wait_for_selector("h1", timeout=60000)

        name = (await page.inner_text("h1")).strip()
        if not name:
            return []

        price = None
        currency = None

        price_meta = await page.query_selector('meta[property="product:price:amount"]')
        curr_meta = await page.query_selector('meta[property="product:price:currency"]')
        if price_meta:
            value = await price_meta.get_attribute("content")
            try:
                price = float(value) if value else None
            except Exception:
                price = None
        if curr_meta:
            currency = await curr_meta.get_attribute("content")

        if price is None:
            price_text = None
            for selector in [
                ".product-detail-price",
                ".product-detail-price-unit",
                ".product-price",
                "[class*='price']",
            ]:
                if el := await page.query_selector(selector):
                    text = (await el.inner_text()).strip()
                    if text:
                        price_text = text
                        break
            price, currency = parse_price(price_text)

        url = None
        if canonical := await page.query_selector('link[rel="canonical"]'):
            url = await canonical.get_attribute("href")
        url = url or page.url

        item_id = self._extract_item_id(url)
        if not item_id:
            if og_title_el := await page.query_selector('meta[property="og:title"]'):
                og_title = await og_title_el.get_attribute("content")
                if og_title and (match := re.search(r"\b(\d{5,})\b", og_title)):
                    item_id = match.group(1)

        image_bytes, image_mime = await self._extract_image(page)

        return [
            Product(
                name=name,
                price=price,
                currency=currency,
                url=url,
                item_id=item_id,
                image=image_bytes,
                image_mime=image_mime,
            )
        ]
