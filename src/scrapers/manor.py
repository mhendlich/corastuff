"""Scraper for Manor.ch Blackroll products."""

from __future__ import annotations

import json
from datetime import UTC, datetime
from urllib.parse import urljoin

from playwright.async_api import Page

from ..models import Product, ScrapeResult
from .base import BaseScraper
from .browser_pool import get_browser_context


class ManorScraper(BaseScraper):
    """Scrape Blackroll products from Manor.ch."""

    name = "manor"
    display_name = "Manor"
    url = "https://www.manor.ch/de/shop/sport/b/blackroll/sport"

    async def scrape(self) -> ScrapeResult:
        async with get_browser_context() as context:
            page = await context.new_page()

            print(f"[{self.name}] Loading {self.url}...")
            await page.goto(self.url, wait_until="domcontentloaded", timeout=90000)
            await page.wait_for_selector('script#__NEXT_DATA__[type="application/json"]', state="attached", timeout=60000)
            await page.wait_for_timeout(500)

            products = await self.extract_products(page)
            print(f"[{self.name}] Extracted {len(products)} products")

        return ScrapeResult(
            source=self.name,
            source_url=self.url,
            scraped_at=datetime.now(UTC),
            products=products,
        )

    @staticmethod
    def _coerce_str(value: object) -> str | None:
        if isinstance(value, str) and value.strip():
            return value.strip()
        return None

    @staticmethod
    def _extract_apollo_state(next_data: dict) -> dict:
        state = (
            next_data.get("props", {})
            .get("pageProps", {})
            .get("initialApolloState")
        )
        return state if isinstance(state, dict) else {}

    @staticmethod
    def _pick_image_url(image_urls: object) -> str | None:
        if not isinstance(image_urls, dict):
            return None
        for key in ("desktop", "tablet", "mobile"):
            url = image_urls.get(key)
            if isinstance(url, str) and url.strip():
                return url.strip()
        return None

    async def _fetch_image(self, page: Page, image_url: str | None) -> tuple[bytes | None, str | None]:
        if not image_url:
            return None, None

        if image_url.startswith("//"):
            image_url = f"https:{image_url}"
        elif image_url.startswith("/"):
            image_url = urljoin("https://www.manor.ch/", image_url)

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
            print(f"[{self.name}] Failed to fetch image: {img_err}")
            return None, None

    async def extract_products(self, page: Page) -> list[Product]:
        script = await page.query_selector('script#__NEXT_DATA__[type="application/json"]')
        if not script:
            return []

        try:
            next_data = json.loads((await script.inner_text() or "").strip())
        except Exception:
            return []

        apollo_state = self._extract_apollo_state(next_data)
        if not apollo_state:
            return []

        products: list[Product] = []
        indexed_products = [
            value
            for value in apollo_state.values()
            if isinstance(value, dict) and value.get("__typename") == "IndexedProduct"
        ]

        for idx, raw in enumerate(indexed_products):
            try:
                name = self._coerce_str(raw.get("name"))
                link = self._coerce_str(raw.get("link"))
                url = urljoin("https://www.manor.ch/", link) if link else None

                price_value = raw.get("priceValue")
                price = None
                currency = None
                if isinstance(price_value, dict):
                    amount = price_value.get("amount")
                    if isinstance(amount, (int, float)):
                        price = float(amount)
                    curr = price_value.get("currency")
                    currency = self._coerce_str(curr)

                item_id = self._coerce_str(raw.get("gtin")) or self._coerce_str(raw.get("baseCode")) or self._coerce_str(
                    raw.get("code")
                )

                image_url = self._pick_image_url(raw.get("imageUrls"))
                image_bytes, image_mime = await self._fetch_image(page, image_url)

                if not name or not url:
                    continue

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
            except Exception as e:
                print(f"[{self.name}] Error extracting product {idx}: {e}")

        return products

