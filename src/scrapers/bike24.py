"""Scraper for Bike24.com Blackroll products.

Bike24 is protected by Cloudflare and blocks headless browsing for the storefront page.
This scraper uses `r.jina.ai` to fetch a simplified listing representation, then
downloads product images via Playwright's request context (which is allowed by the CDN).
"""

from __future__ import annotations

import re
from datetime import UTC, datetime

from playwright.async_api import Page

from ..models import Product, ScrapeResult
from ..utils import parse_price
from .base import BaseScraper
from .browser_pool import get_browser_context


class Bike24Scraper(BaseScraper):
    name = "bike24"
    display_name = "Bike24"
    url = "https://www.bike24.com/brands/blackroll/category-76"

    _PRODUCT_LINK_RE = re.compile(
        r'\]\(https://www\.bike24\.com/p(?P<id>\d+)\.html\s+"(?P<title>[^"]+)"\)'
    )
    _IMAGE_URL_RE = re.compile(r"(https://images\.bike24\.com/[^\s)]+)")
    _PRICE_RE = re.compile(r"(?:from\s+)?[\d][\d\s.,]*\s*€", flags=re.IGNORECASE)

    async def scrape(self) -> ScrapeResult:
        async with get_browser_context() as context:
            listing_url = f"https://r.jina.ai/{self.url}"
            print(f"[{self.name}] Loading {listing_url}...")
            resp = await context.request.get(
                listing_url,
                timeout=60000,
                headers={"Accept": "text/plain"},
            )
            if not resp.ok:
                raise RuntimeError(f"Failed to load listing via r.jina.ai: HTTP {resp.status}")
            markdown = await resp.text()

            products = await self._extract_products_from_markdown(markdown, page_context=context)
            print(f"[{self.name}] Extracted {len(products)} products")

        return ScrapeResult(
            source=self.name,
            source_url=self.url,
            scraped_at=datetime.now(UTC),
            products=products,
        )

    async def extract_products(self, page: Page) -> list[Product]:
        # Not used: Bike24 storefront is blocked by Cloudflare for headless scraping.
        _ = page
        return []

    async def _fetch_image(
        self,
        *,
        page_context,
        image_url: str | None,
    ) -> tuple[bytes | None, str | None]:
        if not image_url:
            return None, None

        try:
            resp = await page_context.request.get(image_url, timeout=30000)
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
            print(f"[{self.name}] Failed to fetch image {image_url}: {img_err}")
            return None, None

    async def _extract_products_from_markdown(self, markdown: str, *, page_context) -> list[Product]:
        products: list[Product] = []
        seen_ids: set[str] = set()

        for match in self._PRODUCT_LINK_RE.finditer(markdown):
            item_id = match.group("id")
            if item_id in seen_ids:
                continue
            seen_ids.add(item_id)

            name = match.group("title").strip()
            url = f"https://www.bike24.com/p{item_id}.html"

            ctx = markdown[max(0, match.start() - 900) : match.start()]

            image_url = None
            img_matches = list(self._IMAGE_URL_RE.finditer(ctx))
            if img_matches:
                image_url = img_matches[-1].group(1)

            price_text = None
            price_matches = list(self._PRICE_RE.finditer(ctx))
            if price_matches:
                price_text = price_matches[-1].group(0)

            price, currency = parse_price(price_text)
            image_bytes, image_mime = await self._fetch_image(
                page_context=page_context,
                image_url=image_url,
            )

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

        return products

