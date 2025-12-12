"""Scraper for bodyguard-shop.ch Blackroll collection (Shopify)."""

from __future__ import annotations

import json
import re
from datetime import UTC, datetime
from urllib.parse import urljoin

from playwright.async_api import BrowserContext, Page

from ..models import Product, ScrapeResult
from ..utils import parse_price
from .base import BaseScraper
from .browser_pool import get_browser_context


class BodyguardShopScraper(BaseScraper):
    """Scrape Blackroll products from bodyguard-shop.ch via Shopify collection JSON."""

    name = "bodyguard_shop"
    display_name = "Bodyguard-shop"
    url = "https://bodyguard-shop.ch/en/collections/blackroll"

    _base_url = "https://bodyguard-shop.ch"
    _collection_json_template = (
        "https://bodyguard-shop.ch/en/collections/blackroll/products.json?limit=250&page={page}"
    )

    async def scrape(self) -> ScrapeResult:
        async with get_browser_context() as context:
            currency = await self._infer_currency(context) or "CHF"
            products = await self._fetch_products(context, currency=currency)
            print(f"[{self.name}] Extracted {len(products)} products")

        return ScrapeResult(
            source=self.name,
            source_url=self.url,
            scraped_at=datetime.now(UTC),
            products=products,
        )

    async def extract_products(self, page: Page) -> list[Product]:
        _ = page
        raise RuntimeError("BodyguardShopScraper uses Shopify JSON endpoints (extract_products is unused).")

    async def _infer_currency(self, context: BrowserContext) -> str | None:
        try:
            resp = await context.request.get(
                self.url,
                headers={"Accept": "text/html"},
                timeout=60000,
            )
            if not resp.ok:
                return None
            html = await resp.text()
        except Exception:
            return None

        if match := re.search(r'Shopify\\.currency\\s*=\\s*(\\{[^;]+\\})', html):
            try:
                payload = json.loads(match.group(1))
                active = payload.get("active")
                if isinstance(active, str) and re.fullmatch(r"[A-Z]{3}", active.strip()):
                    return active.strip()
            except Exception:
                pass

        if match := re.search(r'\"active\"\\s*:\\s*\"([A-Z]{3})\"', html):
            return match.group(1)

        return None

    @staticmethod
    def _best_price(product: dict) -> float | None:
        variants = product.get("variants")
        if not isinstance(variants, list):
            return None

        prices: list[float] = []
        for v in variants:
            if not isinstance(v, dict):
                continue
            raw = v.get("price")
            if raw is None:
                continue
            amount, _ = parse_price(str(raw))
            if amount is not None:
                prices.append(amount)

        return min(prices) if prices else None

    @staticmethod
    def _normalize_url(base_url: str, value: str | None) -> str | None:
        if not value or not isinstance(value, str):
            return None
        url = value.strip()
        if not url:
            return None
        if url.startswith("//"):
            return "https:" + url
        if url.startswith("/"):
            return urljoin(base_url, url)
        return url

    async def _fetch_image(self, context: BrowserContext, image_url: str | None) -> tuple[bytes | None, str | None]:
        image_url = self._normalize_url(self._base_url, image_url)
        if not image_url:
            return None, None

        try:
            resp = await context.request.get(
                image_url,
                headers={
                    "Accept": "image/avif,image/webp,image/apng,image/*,*/*;q=0.8",
                    "Referer": self.url,
                    "Sec-Fetch-Dest": "image",
                    "Sec-Fetch-Mode": "no-cors",
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
        except Exception as img_err:
            print(f"[{self.name}] Failed to fetch image: {img_err}")
            return None, None

    async def _fetch_products(self, context: BrowserContext, *, currency: str) -> list[Product]:
        all_products: list[Product] = []

        for page_num in range(1, 21):
            json_url = self._collection_json_template.format(page=page_num)
            print(f"[{self.name}] Loading {json_url}...")
            resp = await context.request.get(
                json_url,
                headers={"Accept": "application/json"},
                timeout=60000,
            )
            if not resp.ok:
                raise RuntimeError(f"Failed to load collection JSON: HTTP {resp.status}")

            payload = await resp.json()
            items = payload.get("products") if isinstance(payload, dict) else None
            if not items:
                break

            if not isinstance(items, list):
                raise RuntimeError("Unexpected collection JSON shape: products is not a list")

            for idx, item in enumerate(items):
                if not isinstance(item, dict):
                    continue
                title = (item.get("title") or "").strip()
                handle = (item.get("handle") or "").strip()
                if not title or not handle:
                    continue

                product_url = f"{self._base_url}/en/products/{handle}"
                item_id = str(item.get("id") or handle)
                price = self._best_price(item)

                image_url: str | None = None
                images = item.get("images")
                if isinstance(images, list) and images:
                    first = images[0]
                    if isinstance(first, str):
                        image_url = first
                    elif isinstance(first, dict):
                        src = first.get("src")
                        image_url = src if isinstance(src, str) else None
                if not image_url and isinstance(item.get("image"), dict):
                    src = item["image"].get("src")
                    image_url = src if isinstance(src, str) else None

                image_bytes, image_mime = await self._fetch_image(context, image_url)

                all_products.append(
                    Product(
                        name=title,
                        price=price,
                        currency=currency,
                        url=product_url,
                        item_id=item_id,
                        image=image_bytes,
                        image_mime=image_mime,
                    )
                )

            if len(items) < 250:
                break

        return all_products
