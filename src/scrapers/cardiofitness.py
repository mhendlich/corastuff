"""Scraper for cardiofitness.de Blackroll products (Shopify collection JSON)."""

from __future__ import annotations

import asyncio
from datetime import UTC, datetime
from typing import Any
from urllib.parse import urlencode, urljoin

import httpx
from playwright.async_api import Page

from ..models import Product, ScrapeResult
from ..utils import parse_price
from .base import BaseScraper


class CardioFitnessScraper(BaseScraper):
    """Scrape Blackroll products from cardiofitness.de."""

    name = "cardiofitness"
    display_name = "Cardiofitness"
    url = "https://www.cardiofitness.de/collections/blackroll"

    _BASE = "https://www.cardiofitness.de/"
    _COLLECTION_PRODUCTS_JSON = "https://www.cardiofitness.de/collections/blackroll/products.json"

    async def scrape(self) -> ScrapeResult:
        products = await self._scrape_shopify_collection_products_json()
        print(f"[{self.name}] Extracted {len(products)} products")
        return ScrapeResult(
            source=self.name,
            source_url=self.url,
            scraped_at=datetime.now(UTC),
            products=products,
        )

    async def extract_products(self, page: Page) -> list[Product]:
        _ = page
        return []

    @staticmethod
    def _coerce_str(value: object) -> str | None:
        if isinstance(value, str) and value.strip():
            return value.strip()
        return None

    @staticmethod
    def _coerce_price(value: object) -> float | None:
        if value is None:
            return None
        if isinstance(value, (int, float)) and not isinstance(value, bool):
            v = float(value)
            return v if v > 0 else None
        if isinstance(value, str):
            amount, _currency = parse_price(value)
            return amount if amount is not None and amount > 0 else None
        return None

    def _product_url(self, handle: str | None) -> str | None:
        if not handle:
            return None
        return urljoin(self._BASE, f"products/{handle.lstrip('/')}")

    @staticmethod
    def _pick_variant(raw: dict[str, Any]) -> dict[str, Any] | None:
        variants = raw.get("variants")
        if not isinstance(variants, list) or not variants:
            return None
        for v in variants:
            if isinstance(v, dict) and v.get("available") is True:
                return v
        return variants[0] if isinstance(variants[0], dict) else None

    @staticmethod
    def _pick_image_url(raw: dict[str, Any]) -> str | None:
        images = raw.get("images")
        if not isinstance(images, list) or not images:
            return None
        first = images[0]
        if isinstance(first, dict):
            url = first.get("src")
            return url.strip() if isinstance(url, str) and url.strip() else None
        if isinstance(first, str) and first.strip():
            return first.strip()
        return None

    async def _scrape_shopify_collection_products_json(self) -> list[Product]:
        headers = {
            "user-agent": (
                "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 "
                "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"
            ),
            "accept": "application/json,text/plain,*/*",
            "accept-language": "de-DE,de;q=0.9,en-US;q=0.8,en;q=0.7",
        }

        timeout = httpx.Timeout(60.0)
        products: list[Product] = []
        image_urls: dict[str, str] = {}
        seen: set[str] = set()

        async with httpx.AsyncClient(headers=headers, follow_redirects=True, timeout=timeout) as client:
            page_num = 1
            while True:
                page_url = f"{self._COLLECTION_PRODUCTS_JSON}?{urlencode({'limit': 250, 'page': page_num})}"
                print(f"[{self.name}] Loading {page_url}...")
                resp = await client.get(page_url)
                resp.raise_for_status()
                payload = resp.json()
                raw_products = payload.get("products")
                if not isinstance(raw_products, list) or not raw_products:
                    break

                for raw in raw_products:
                    if not isinstance(raw, dict):
                        continue

                    item_id = raw.get("id")
                    item_id_str = str(item_id) if item_id is not None else None
                    if item_id_str and item_id_str in seen:
                        continue
                    if item_id_str:
                        seen.add(item_id_str)

                    name = self._coerce_str(raw.get("title"))
                    handle = self._coerce_str(raw.get("handle"))
                    url = self._product_url(handle)

                    variant = self._pick_variant(raw) or {}
                    price = self._coerce_price(variant.get("price"))
                    currency = "EUR" if price is not None else None

                    if item_id_str:
                        if image_url := self._pick_image_url(raw):
                            image_urls[item_id_str] = image_url

                    if not name:
                        continue

                    products.append(
                        Product(
                            name=name,
                            price=price,
                            currency=currency,
                            url=url,
                            item_id=item_id_str,
                        )
                    )

                page_num += 1

            if not products:
                return []

            semaphore = asyncio.Semaphore(8)

            async def fetch_image(item_id: str, image_url: str) -> tuple[str, bytes | None, str | None]:
                async with semaphore:
                    body, mime = await self._fetch_image(client, referer=self.url, image_url=image_url)
                    return item_id, body, mime

            tasks = [
                fetch_image(item_id, img_url)
                for item_id, img_url in image_urls.items()
                if item_id and isinstance(img_url, str) and img_url.strip()
            ]
            results = await asyncio.gather(*tasks, return_exceptions=True)

            images_by_id: dict[str, tuple[bytes | None, str | None]] = {}
            for idx, r in enumerate(results):
                if isinstance(r, Exception):
                    print(f"[{self.name}] Image fetch error {idx}: {r}")
                    continue
                item_id, body, mime = r
                if body and mime:
                    images_by_id[item_id] = (body, mime)

        for p in products:
            if not p.item_id:
                continue
            image = images_by_id.get(p.item_id)
            if image:
                p.image, p.image_mime = image

        return products

    @staticmethod
    async def _fetch_image(
        client: httpx.AsyncClient,
        *,
        referer: str,
        image_url: str,
    ) -> tuple[bytes | None, str | None]:
        try:
            resp = await client.get(
                image_url,
                timeout=httpx.Timeout(30.0),
                headers={
                    "Accept": "image/avif,image/webp,image/apng,image/*,*/*;q=0.8",
                    "Referer": referer,
                    "Sec-Fetch-Dest": "image",
                    "Sec-Fetch-Mode": "no-cors",
                    "Sec-Fetch-Site": "cross-site",
                },
            )
            if resp.status_code >= 400:
                return None, None
            body = resp.content
            if not body or len(body) < 800:
                return None, None
            mime = resp.headers.get("content-type")
            if mime and ";" in mime:
                mime = mime.split(";", 1)[0].strip()
            if mime and not mime.startswith("image/"):
                return None, None
            return body, mime
        except Exception:
            return None, None
