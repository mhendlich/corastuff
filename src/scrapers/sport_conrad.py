"""Scraper for sport-conrad.com Blackroll products."""

from __future__ import annotations

import json
from datetime import UTC, datetime
from urllib.parse import urlencode

from playwright.async_api import Page

from ..models import Product, ScrapeResult
from .base import BaseScraper
from .browser_pool import get_browser_context


_STEALTH_INIT_SCRIPT = """
Object.defineProperty(navigator, 'webdriver', {get: () => undefined});
Object.defineProperty(navigator, 'languages', {get: () => ['de-DE','de','en-US','en']});
Object.defineProperty(navigator, 'plugins', {get: () => [1,2,3,4,5]});
""".strip()


class SportConradScraper(BaseScraper):
    """Scrape Blackroll products from sport-conrad.com."""

    name = "sport_conrad"
    display_name = "Sport Conrad"
    url = "https://www.sport-conrad.com/marken/blackroll/"

    _BASE = "https://www.sport-conrad.com/"
    _PAGE_SIZE = 72

    async def scrape(self) -> ScrapeResult:
        async with get_browser_context(
            user_agent=(
                "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 "
                "(KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36"
            ),
            locale="de-DE",
            viewport={"width": 1365, "height": 768},
            init_scripts=[_STEALTH_INIT_SCRIPT],
        ) as context:
            page = await context.new_page()

            products: list[Product] = []
            seen: set[str] = set()
            image_urls: dict[str, str] = {}

            offset = 0
            total: int | None = None

            while True:
                page_url = self._build_page_url(offset=offset, count=self._PAGE_SIZE)
                print(f"[{self.name}] Loading {page_url}...")
                await page.goto(page_url, wait_until="domcontentloaded", timeout=90000)
                await page.wait_for_selector("script#__NEXT_DATA__", timeout=60000, state="attached")

                payload = await self._read_next_data(page)
                extracted = self._extract_products_and_image_urls_from_next_data(payload)
                if total is None:
                    total = self._extract_total_from_next_data(payload)
                    print(f"[{self.name}] Total products reported: {total}")

                for p, image_url in extracted:
                    if p.item_id and p.item_id in seen:
                        continue
                    if p.item_id:
                        seen.add(p.item_id)
                        if image_url:
                            image_urls[p.item_id] = image_url
                    products.append(p)

                if total is None or offset + self._PAGE_SIZE >= total:
                    break
                offset += self._PAGE_SIZE

            print(f"[{self.name}] Fetching images for {len(products)} products...")
            for idx, p in enumerate(products):
                if not p.item_id:
                    continue
                try:
                    image_url = image_urls.get(p.item_id)
                    if not image_url:
                        continue
                    image_bytes, image_mime = await self._fetch_image(page, image_url)
                    p.image = image_bytes
                    p.image_mime = image_mime
                except Exception as e:
                    print(f"[{self.name}] Failed to fetch image for product {idx}: {e}")

        return ScrapeResult(
            source=self.name,
            source_url=self.url,
            scraped_at=datetime.now(UTC),
            products=products,
        )

    async def extract_products(self, page: Page) -> list[Product]:
        # Unused: scraper overrides `scrape()` to handle pagination.
        return []

    def _build_page_url(self, *, offset: int, count: int) -> str:
        return f"{self.url}?{urlencode({'count': count, 'offset': offset})}"

    @staticmethod
    async def _read_next_data(page: Page) -> dict:
        raw = await page.eval_on_selector("script#__NEXT_DATA__", "el => el.textContent")
        if not raw or not isinstance(raw, str):
            raise RuntimeError("__NEXT_DATA__ not found or empty")
        return json.loads(raw)

    def _extract_products_and_image_urls_from_next_data(self, data: dict) -> list[tuple[Product, str | None]]:
        items = (
            data.get("props", {})
            .get("pageProps", {})
            .get("pageProps", {})
            .get("pageData", {})
            .get("data", {})
            .get("product", {})
            .get("items", [])
        )
        products: list[tuple[Product, str | None]] = []
        if not isinstance(items, list):
            return products

        for item in items:
            if not isinstance(item, dict):
                continue
            fields = item.get("fields")
            if not isinstance(fields, dict):
                continue

            name = (fields.get("oxtitle") or fields.get("title") or "").strip()
            if not name:
                continue

            item_id = fields.get("oxid") or fields.get("id")
            if item_id is not None:
                item_id = str(item_id).strip() or None

            url = fields.get("url")
            if isinstance(url, str) and url.strip():
                url = url.strip()
                if not url.startswith("http"):
                    url = self._BASE + url.lstrip("/")
            else:
                url = None

            price = fields.get("oxprice")
            if price is None:
                price = fields.get("price")
            try:
                price = float(price) if price is not None else None
            except Exception:
                price = None

            image_url = fields.get("picture_url_main")
            if not isinstance(image_url, str) or not image_url.strip():
                image_url = None
            else:
                image_url = image_url.strip()

            products.append(
                (
                    Product(
                    name=name,
                    price=price,
                    currency="EUR",
                    url=url,
                    item_id=item_id,
                    ),
                    image_url,
                )
            )

        return products

    @staticmethod
    def _extract_total_from_next_data(data: dict) -> int | None:
        product = (
            data.get("props", {})
            .get("pageProps", {})
            .get("pageProps", {})
            .get("pageData", {})
            .get("data", {})
            .get("product", {})
        )
        if not isinstance(product, dict):
            return None
        total = product.get("total")
        try:
            return int(total) if total is not None else None
        except Exception:
            return None

    async def _fetch_image(self, page: Page, image_url: str) -> tuple[bytes | None, str | None]:
        try:
            resp = await page.context.request.get(
                image_url,
                timeout=30000,
                headers={
                    "Accept": "image/avif,image/webp,image/apng,image/*,*/*;q=0.8",
                    "Referer": page.url,
                    "Sec-Fetch-Dest": "image",
                    "Sec-Fetch-Mode": "no-cors",
                    "Sec-Fetch-Site": "cross-site",
                },
            )
            if not resp.ok:
                return None, None
            body = await resp.body()
            if len(body) < 800:
                return None, None
            mime = resp.headers.get("content-type")
            if mime and ";" in mime:
                mime = mime.split(";", 1)[0].strip()
            if mime and not mime.startswith("image/"):
                return None, None
            return body, mime
        except Exception:
            return None, None
