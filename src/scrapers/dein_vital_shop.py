"""Scraper for Dein-Vital (Shopify) Blackroll collection."""

from __future__ import annotations

from urllib.parse import urljoin

from playwright.async_api import Page

from ..models import Product
from ..utils import parse_price
from .base import BaseScraper


class DeinVitalShopScraper(BaseScraper):
    name = "dein_vital_shop"
    display_name = "Dein-Vital (Blackroll)"
    url = "https://dein-vital.shop/collections/blackroll/blackroll"

    user_agent = (
        "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 "
        "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"
    )
    locale = "de-DE"
    viewport = {"width": 1920, "height": 1080}
    init_scripts = [
        """
        Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
        """.strip()
    ]

    _base_url = "https://dein-vital.shop"
    _collection_products_json = "https://dein-vital.shop/collections/blackroll/products.json?limit=250&page={page}"
    _currency = "EUR"

    @staticmethod
    def _pick_best_image_url(images: list[dict] | None) -> str | None:
        if not images:
            return None
        best = None
        for img in images:
            if not isinstance(img, dict):
                continue
            src = img.get("src")
            if not isinstance(src, str) or not src.strip():
                continue
            if best is None:
                best = img
                continue
            try:
                if int(img.get("width") or 0) >= int(best.get("width") or 0):
                    best = img
            except Exception:
                continue
        if best and isinstance(best.get("src"), str):
            return best["src"]
        return None

    async def _fetch_image(self, page: Page, image_url: str) -> tuple[bytes | None, str | None]:
        try:
            resp = await page.context.request.get(
                image_url,
                headers={
                    "Accept": "image/avif,image/webp,image/apng,image/*,*/*;q=0.8",
                    "Referer": self.url,
                    "Sec-Fetch-Dest": "image",
                    "Sec-Fetch-Mode": "no-cors",
                    "Sec-Fetch-Site": "cross-site",
                },
                timeout=30000,
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
        except Exception:
            return None, None

    async def extract_products(self, page: Page) -> list[Product]:
        products: list[Product] = []

        for page_num in range(1, 51):
            api_url = self._collection_products_json.format(page=page_num)
            resp = await page.context.request.get(
                api_url,
                headers={"Accept": "application/json", "Referer": self.url},
                timeout=45000,
            )
            if not resp.ok:
                break
            payload = await resp.json()
            items = payload.get("products") if isinstance(payload, dict) else None
            if not isinstance(items, list) or not items:
                break

            for item in items:
                if not isinstance(item, dict):
                    continue

                title = item.get("title")
                if not isinstance(title, str) or not title.strip():
                    continue
                item_id = item.get("id")
                item_id_str = str(item_id) if item_id is not None else None

                handle = item.get("handle")
                product_url = (
                    urljoin(self._base_url, f"/products/{handle}") if isinstance(handle, str) and handle else None
                )

                price: float | None = None
                variants = item.get("variants")
                if isinstance(variants, list) and variants:
                    prices: list[float] = []
                    for v in variants:
                        if not isinstance(v, dict):
                            continue
                        p, _ = parse_price(v.get("price"))
                        if p is not None:
                            prices.append(p)
                    if prices:
                        price = min(prices)

                image_url = self._pick_best_image_url(item.get("images"))
                image_bytes = None
                image_mime = None
                if image_url:
                    image_bytes, image_mime = await self._fetch_image(page, image_url)

                products.append(
                    Product(
                        name=title.strip(),
                        price=price,
                        currency=self._currency,
                        url=product_url,
                        item_id=item_id_str,
                        image=image_bytes,
                        image_mime=image_mime,
                    )
                )

        return products

