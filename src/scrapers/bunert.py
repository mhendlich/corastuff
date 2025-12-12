"""Scraper for Bunert.de Blackroll product(s)."""

from __future__ import annotations

from datetime import datetime, UTC
from urllib.parse import urljoin

from playwright.async_api import Page

from ..models import Product, ScrapeResult
from .base import BaseScraper
from .browser_pool import get_browser_context


_DESKTOP_UA = (
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36"
)

_HIDE_WEBDRIVER = """
Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
"""


class BunertScraper(BaseScraper):
    name = "bunert"
    display_name = "Bunert"
    url = "https://www.bunert.de/blackroll-standard-faszienrolle"

    async def scrape(self) -> ScrapeResult:
        async with get_browser_context(
            user_agent=_DESKTOP_UA,
            locale="de-DE",
            viewport={"width": 1400, "height": 900},
            init_scripts=[_HIDE_WEBDRIVER],
        ) as context:
            page = await context.new_page()
            print(f"[{self.name}] Loading {self.url}...")
            await page.goto(self.url, wait_until="domcontentloaded", timeout=90000)
            await page.wait_for_timeout(400)

            products = await self.extract_products(page)
            print(f"[{self.name}] Extracted {len(products)} products")

        return ScrapeResult(
            source=self.name,
            source_url=self.url,
            scraped_at=datetime.now(UTC),
            products=products,
        )

    @staticmethod
    async def _data_layer_products(page: Page) -> tuple[list[dict], str | None]:
        data_layer = await page.evaluate("() => window.dataLayer || []")
        if not isinstance(data_layer, list):
            return [], None

        for entry in data_layer:
            if not isinstance(entry, dict):
                continue
            ecommerce = entry.get("ecommerce")
            if not isinstance(ecommerce, dict):
                continue
            detail = ecommerce.get("detail")
            if not isinstance(detail, dict):
                continue
            products = detail.get("products")
            if isinstance(products, list) and products:
                currency = ecommerce.get("currencyCode")
                return [p for p in products if isinstance(p, dict)], currency if isinstance(currency, str) else None
        return [], None

    @staticmethod
    async def _fetch_image(page: Page, image_url: str) -> tuple[bytes | None, str | None]:
        headers = {
            "Accept": "image/avif,image/webp,image/*,*/*;q=0.8",
            "Referer": page.url,
            "Sec-Fetch-Dest": "image",
            "Sec-Fetch-Mode": "no-cors",
        }
        resp = await page.context.request.get(image_url, timeout=45000, headers=headers)
        if not resp.ok:
            return None, None
        body = await resp.body()
        if len(body) < 800:
            return None, None
        mime = resp.headers.get("content-type")
        if mime and ";" in mime:
            mime = mime.split(";", 1)[0].strip()
        return body, mime

    async def extract_products(self, page: Page) -> list[Product]:
        dl_products, currency = await self._data_layer_products(page)

        name = None
        item_id = None
        price = None

        if dl_products:
            p0 = dl_products[0]
            if isinstance(p0.get("name"), str):
                name = p0["name"].strip() or None
            if isinstance(p0.get("id"), str):
                item_id = p0["id"].strip() or None
            raw_price = p0.get("price")
            try:
                if raw_price is not None:
                    price = float(str(raw_price).replace(",", "."))
            except Exception:
                price = None

        if not currency:
            currency = "EUR"

        if not name:
            try:
                title = await page.title()
                name = (title or "").split("|")[0].strip() or None
            except Exception:
                name = None

        image_url = await page.get_attribute('meta[property="og:image"]', "content")
        if image_url:
            image_url = urljoin(page.url, image_url)

        image_bytes = None
        image_mime = None
        if image_url:
            try:
                image_bytes, image_mime = await self._fetch_image(page, image_url)
            except Exception as e:
                print(f"[{self.name}] Failed to fetch image: {e}")

        if not name:
            return []

        return [
            Product(
                name=name,
                price=price,
                currency=currency,
                url=page.url,
                item_id=item_id,
                image=image_bytes,
                image_mime=image_mime,
            )
        ]

