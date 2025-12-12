"""Scraper for keller-sports.de Blackroll products."""

from __future__ import annotations

import json
from datetime import datetime, UTC
from urllib.parse import urljoin, urlparse

from playwright.async_api import Page

from ..models import Product, ScrapeResult
from .base import BaseScraper
from .browser_pool import get_browser_context


class KellerSportsScraper(BaseScraper):
    """Scrape Blackroll products from keller-sports.de."""

    name = "keller_sports"
    display_name = "Keller Sports"
    url = "https://keller-sports.de/brands/blackroll.html"

    async def scrape(self) -> ScrapeResult:
        async with get_browser_context() as context:
            page = await context.new_page()

            print(f"[{self.name}] Loading {self.url}...")
            await page.goto(self.url, wait_until="domcontentloaded", timeout=90000)

            await self._handle_cookie_consent(page)
            await page.wait_for_timeout(800)

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
            'button:has-text("Alle akzeptieren")',
            'button:has-text("Akzeptieren")',
            "#onetrust-accept-btn-handler",
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
    def _extract_item_id(url: str | None, sku: str | None = None) -> str | None:
        if sku:
            return str(sku).strip() or None
        if not url:
            return None
        try:
            path = urlparse(url).path.strip("/")
        except Exception:
            path = url.strip("/")
        if not path:
            return None
        slug = path.split("/")[-1].removesuffix(".html")
        return slug or None

    @staticmethod
    def _extract_json_array(text: str, array_start_idx: int) -> str | None:
        if array_start_idx < 0 or array_start_idx >= len(text) or text[array_start_idx] != "[":
            return None

        in_str = False
        escape = False
        depth = 0

        for i in range(array_start_idx, len(text)):
            ch = text[i]
            if in_str:
                if escape:
                    escape = False
                elif ch == "\\":
                    escape = True
                elif ch == '"':
                    in_str = False
                continue

            if ch == '"':
                in_str = True
                continue
            if ch == "[":
                depth += 1
                continue
            if ch == "]":
                depth -= 1
                if depth == 0:
                    return text[array_start_idx : i + 1]

        return None

    @staticmethod
    def _find_items_array(content: str) -> str | None:
        candidates: list[int] = []
        idx = 0
        while True:
            idx = content.find('"items":[', idx)
            if idx == -1:
                break
            snippet = content[idx : idx + 2500]
            if '"product_url"' in snippet and '"list_image"' in snippet and '"price"' in snippet:
                candidates.append(idx)
                break
            idx += 8

        if not candidates:
            return None

        array_start = candidates[0] + len('"items":')
        return KellerSportsScraper._extract_json_array(content, array_start)

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
        content = await page.content()
        items_array = self._find_items_array(content)
        if not items_array:
            raise RuntimeError("Unable to locate product data (items array) in page content")

        items = json.loads(items_array)
        products: list[Product] = []

        for idx, item in enumerate(items):
            try:
                name = (item.get("name") or "").strip() or None
                brand = (item.get("brand_value") or "").strip() or None
                full_name = f"{brand} {name}".strip() if brand else name

                url = item.get("product_url")
                if url and isinstance(url, str):
                    url = urljoin("https://keller-sports.de/", url)
                else:
                    url = None

                price_raw = item.get("price")
                price = float(price_raw) if isinstance(price_raw, (int, float)) else None

                image_url = item.get("list_image")
                if image_url and isinstance(image_url, str):
                    image_url = urljoin("https://keller-sports.de/", image_url)
                else:
                    image_url = None

                image_bytes, image_mime = await self._fetch_image(page, image_url)

                if not full_name or not url:
                    continue

                products.append(
                    Product(
                        name=full_name,
                        price=price,
                        currency="EUR",
                        url=url,
                        item_id=self._extract_item_id(url, sku=item.get("sku")),
                        image=image_bytes,
                        image_mime=image_mime,
                    )
                )
            except Exception as e:
                print(f"[{self.name}] Error extracting item {idx}: {e}")

        return products

