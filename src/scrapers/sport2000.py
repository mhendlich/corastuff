"""Scraper for Sport2000.de Blackroll products."""

from __future__ import annotations

import asyncio
import json
from datetime import UTC, datetime
from typing import Any
from urllib.parse import urljoin

import httpx
from bs4 import BeautifulSoup
from playwright.async_api import Page

from ..models import Product, ScrapeResult
from .base import BaseScraper


class Sport2000Scraper(BaseScraper):
    """Scrape Blackroll products from Sport2000.de."""

    name = "sport2000"
    display_name = "SPORT 2000"
    url = "https://www.sport2000.de/brands/blackroll"

    async def scrape(self) -> ScrapeResult:
        products = await self._scrape_next_data()
        print(f"[{self.name}] Extracted {len(products)} products")
        return ScrapeResult(
            source=self.name,
            source_url=self.url,
            scraped_at=datetime.now(UTC),
            products=products,
        )

    async def extract_products(self, page: Page) -> list[Product]:
        # This scraper uses the server-rendered Next.js payload via HTTP (see _scrape_next_data).
        # Implemented only to satisfy the BaseScraper interface.
        _ = page
        return []

    async def _scrape_next_data(self) -> list[Product]:
        headers = {
            "user-agent": (
                "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 "
                "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"
            ),
            "accept-language": "de-DE,de;q=0.9,en-US;q=0.8,en;q=0.7",
        }

        async with httpx.AsyncClient(
            follow_redirects=True,
            headers=headers,
            timeout=httpx.Timeout(60.0),
        ) as client:
            print(f"[{self.name}] Loading {self.url}...")
            resp = await client.get(self.url)
            resp.raise_for_status()

            hits = self._extract_hits_from_html(resp.text)
            if not hits:
                return []

            semaphore = asyncio.Semaphore(8)

            async def build(hit: dict[str, Any]) -> Product | None:
                name = (hit.get("name") or "").strip() or None
                if not name:
                    return None

                product_url = hit.get("product_url") or hit.get("url")
                full_url = urljoin("https://www.sport2000.de", str(product_url)) if product_url else None
                item_id = hit.get("sku") or hit.get("product_key") or hit.get("product_id")

                price = self._extract_price_eur(hit)
                currency = "EUR" if price is not None else None

                image_url = hit.get("image")
                image_bytes = None
                image_mime = None

                if image_url:
                    async with semaphore:
                        image_bytes, image_mime = await self._fetch_image(client, str(image_url))

                return Product(
                    name=name,
                    price=price,
                    currency=currency,
                    url=full_url,
                    item_id=str(item_id) if item_id is not None else None,
                    image=image_bytes,
                    image_mime=image_mime,
                )

            tasks = [build(hit) for hit in hits]
            built = await asyncio.gather(*tasks, return_exceptions=True)

            products: list[Product] = []
            for idx, result in enumerate(built):
                if isinstance(result, Exception):
                    print(f"[{self.name}] Error building product {idx}: {result}")
                    continue
                if result is not None:
                    products.append(result)

            return products

    @staticmethod
    def _extract_hits_from_html(html: str) -> list[dict[str, Any]]:
        soup = BeautifulSoup(html, "lxml")
        script = soup.find("script", {"id": "__NEXT_DATA__"})
        if not script or not script.string:
            return []

        try:
            data = json.loads(script.string)
        except Exception:
            return []

        data_sources = (
            data.get("props", {})
            .get("pageProps", {})
            .get("data", {})
            .get("data", {})
            .get("dataSources", {})
        )

        for key, value in (data_sources or {}).items():
            if not isinstance(key, str) or not key.endswith("-stream") or not isinstance(value, dict):
                continue
            raw_results = value.get("rawResults")
            if not isinstance(raw_results, list) or not raw_results or not isinstance(raw_results[0], dict):
                continue
            hits = raw_results[0].get("hits")
            if isinstance(hits, list) and hits and isinstance(hits[0], dict):
                return hits  # type: ignore[return-value]

        return []

    @staticmethod
    def _extract_price_eur(hit: dict[str, Any]) -> float | None:
        def normalize(value: Any) -> float | None:
            if value is None:
                return None
            if isinstance(value, bool):
                return None
            if isinstance(value, (int, float)):
                if value <= 0:
                    return None
                # Sport2000 prices are typically integer cents.
                if isinstance(value, int):
                    return float(value) / 100.0
                # If it's a float but looks like cents, normalize.
                return float(value) / 100.0 if value > 1000 else float(value)
            return None

        # Prefer explicit discounted price.
        for field in ("discountedPrice", "price", "min_price", "max_price"):
            if (val := normalize(hit.get(field))) is not None:
                return val

        # Fallback: channel_prices -> first channel -> first entry.
        channel_prices = hit.get("channel_prices")
        if isinstance(channel_prices, dict):
            for _, entries in channel_prices.items():
                if not isinstance(entries, list) or not entries:
                    continue
                first = entries[0]
                if isinstance(first, dict):
                    if (val := normalize(first.get("discountedPrice"))) is not None:
                        return val
                    if (val := normalize(first.get("price"))) is not None:
                        return val

        return None

    @staticmethod
    async def _fetch_image(client: httpx.AsyncClient, url: str) -> tuple[bytes | None, str | None]:
        try:
            resp = await client.get(url, timeout=httpx.Timeout(30.0))
            if resp.status_code >= 400:
                return None, None
            body = resp.content
            if not body or len(body) < 800:
                return None, None
            mime = resp.headers.get("content-type")
            if mime and ";" in mime:
                mime = mime.split(";", 1)[0].strip()
            return body, mime
        except Exception:
            return None, None
