"""Scraper for oezpinar.de Blackroll products (Shopware search results)."""

from __future__ import annotations

import asyncio
import json
import re
from datetime import UTC, datetime
from typing import Any
from urllib.parse import urlencode

import httpx
from bs4 import BeautifulSoup
from playwright.async_api import Page

from ..models import Product, ScrapeResult
from ..utils import parse_price
from .base import BaseScraper


class OezpinarScraper(BaseScraper):
    name = "oezpinar"
    display_name = "Özpinar"
    url = "https://www.oezpinar.de/search?sSearch=blackroll"

    _SEARCH_URL = "https://www.oezpinar.de/search"

    async def scrape(self) -> ScrapeResult:
        products = await self._scrape_search_results()
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
    def _default_headers() -> dict[str, str]:
        return {
            "user-agent": (
                "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 "
                "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"
            ),
            "accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
            "accept-language": "de-DE,de;q=0.9,en-US;q=0.8,en;q=0.7",
        }

    @staticmethod
    def _extract_datalayer_payload(html: str) -> dict[str, Any] | None:
        # Shopware pages commonly embed GTM data as:
        # window.dataLayer.push({ ... });
        match = re.search(r"dataLayer\.push\((\{.*?\})\);", html, flags=re.DOTALL)
        if not match:
            return None
        raw = match.group(1).strip()
        try:
            payload = json.loads(raw)
        except Exception:
            return None
        return payload if isinstance(payload, dict) else None

    @staticmethod
    def _pick_srcset_url(srcset: str | None) -> str | None:
        if not srcset or not isinstance(srcset, str):
            return None
        candidates = [c.strip() for c in srcset.split(",") if c.strip()]
        if not candidates:
            return None
        # Prefer the last candidate (often "2x" / higher-res).
        last = candidates[-1]
        return last.split()[0].strip() if last else None

    @staticmethod
    def _parse_products_from_html(html: str) -> tuple[list[dict[str, Any]], int]:
        soup = BeautifulSoup(html, "lxml")

        listing = soup.select_one("div.listing[data-pages]")
        total_pages = 1
        if listing:
            raw_pages = listing.get("data-pages")
            try:
                total_pages = max(1, int(str(raw_pages).strip()))
            except Exception:
                total_pages = 1

        products: list[dict[str, Any]] = []
        for box in soup.select("div.product--box[data-ordernumber]"):
            item_id = box.get("data-ordernumber")
            item_id = str(item_id).strip() if item_id is not None else None
            if not item_id:
                continue

            title_el = box.select_one("a.product--title[href]")
            name = title_el.get_text(" ", strip=True) if title_el else None
            url = title_el.get("href") if title_el else None

            price_text = None
            price_el = box.select_one(".product--price .price--default")
            if price_el:
                price_text = price_el.get_text(" ", strip=True)
            price, currency = parse_price(price_text)

            image_url = None
            img = box.select_one("a.product--image img")
            if img:
                image_url = (
                    OezpinarScraper._pick_srcset_url(img.get("srcset"))
                    or (img.get("src") if isinstance(img.get("src"), str) else None)
                )

            products.append(
                {
                    "item_id": item_id,
                    "name": name,
                    "url": url,
                    "price": price,
                    "currency": currency,
                    "image_url": image_url,
                }
            )

        return products, total_pages

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
                    "Sec-Fetch-Site": "same-origin",
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

    async def _scrape_search_results(self) -> list[Product]:
        headers = self._default_headers()
        timeout = httpx.Timeout(60.0)

        products_by_id: dict[str, dict[str, Any]] = {}
        impressions_by_id: dict[str, dict[str, Any]] = {}
        currency_code: str | None = None
        referer = self.url

        async with httpx.AsyncClient(headers=headers, follow_redirects=True, timeout=timeout) as client:
            page_num = 1
            total_pages = 1
            while page_num <= total_pages:
                page_url = f"{self._SEARCH_URL}?{urlencode({'sSearch': 'blackroll', 'p': page_num, 'n': 48})}"
                print(f"[{self.name}] Loading {page_url}...")
                resp = await client.get(page_url)
                resp.raise_for_status()
                html = resp.text

                if page_num == 1:
                    if (dl := self._extract_datalayer_payload(html)) and isinstance(dl.get("ecommerce"), dict):
                        ecommerce = dl["ecommerce"]
                        if isinstance(ecommerce.get("currencyCode"), str):
                            currency_code = ecommerce["currencyCode"].strip() or None
                        raw_impressions = ecommerce.get("impressions")
                        if isinstance(raw_impressions, list):
                            for imp in raw_impressions:
                                if not isinstance(imp, dict):
                                    continue
                                item_id = imp.get("id")
                                item_id = str(item_id).strip() if item_id is not None else None
                                if item_id:
                                    impressions_by_id[item_id] = imp

                raw_products, total_pages = self._parse_products_from_html(html)
                if not raw_products:
                    break

                for raw in raw_products:
                    item_id = raw.get("item_id")
                    if not isinstance(item_id, str) or not item_id.strip():
                        continue
                    if item_id not in products_by_id:
                        products_by_id[item_id] = raw

                page_num += 1

            if not products_by_id:
                return []

            # Fill missing fields from dataLayer impressions when present.
            for item_id, raw in products_by_id.items():
                imp = impressions_by_id.get(item_id) or {}
                if not raw.get("name") and isinstance(imp.get("name"), str):
                    raw["name"] = imp["name"].strip()
                if raw.get("price") is None and isinstance(imp.get("price"), (int, float)) and not isinstance(
                    imp.get("price"), bool
                ):
                    raw["price"] = float(imp["price"])
                if not raw.get("currency") and currency_code:
                    raw["currency"] = currency_code

            # Fetch images.
            semaphore = asyncio.Semaphore(8)

            async def fetch_one(item_id: str, image_url: str) -> tuple[str, bytes | None, str | None]:
                async with semaphore:
                    body, mime = await self._fetch_image(client, referer=referer, image_url=image_url)
                    return item_id, body, mime

            tasks = [
                fetch_one(item_id, raw["image_url"])
                for item_id, raw in products_by_id.items()
                if isinstance(raw.get("image_url"), str) and raw["image_url"].strip()
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

        products: list[Product] = []
        for item_id, raw in products_by_id.items():
            name = raw.get("name")
            if not isinstance(name, str) or not name.strip():
                continue
            url = raw.get("url")
            url = url.strip() if isinstance(url, str) and url.strip() else None

            price = raw.get("price")
            if isinstance(price, bool):
                price = None
            if isinstance(price, (int, float)):
                price = float(price)
            else:
                price = None

            currency = raw.get("currency")
            currency = currency.strip() if isinstance(currency, str) and currency.strip() else None

            image_bytes = None
            image_mime = None
            if item_id in images_by_id:
                image_bytes, image_mime = images_by_id[item_id]

            products.append(
                Product(
                    name=name.strip(),
                    price=price,
                    currency=currency,
                    url=url,
                    item_id=item_id,
                    image=image_bytes,
                    image_mime=image_mime,
                )
            )

        return products

