"""Scraper for kuebler-sport.de Blackroll products."""

from __future__ import annotations

import json
import re
from datetime import datetime, UTC
from urllib.parse import urljoin, urlparse

from playwright.async_api import Page

from ..models import Product, ScrapeResult
from .base import BaseScraper
from .browser_pool import get_browser_context


class KueblerSportScraper(BaseScraper):
    """Scrape Blackroll products from kuebler-sport.de."""

    name = "kuebler_sport"
    display_name = "Kübler Sport"
    url = "https://www.kuebler-sport.de/marken/blackroll/"

    async def scrape(self) -> ScrapeResult:
        async with get_browser_context() as context:
            page = await context.new_page()

            print(f"[{self.name}] Loading {self.url}...")
            await page.goto(self.url, wait_until="domcontentloaded", timeout=90000)

            await self._handle_cookie_consent(page)
            await page.wait_for_selector('script[type="application/ld+json"]', timeout=60000, state="attached")
            await page.wait_for_timeout(600)

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
            'button:has-text("Zustimmen")',
            'button:has-text("Accept all")',
            'button:has-text("Allow all")',
            "#onetrust-accept-btn-handler",
            '[data-testid="uc-accept-all-button"]',
            "button#acceptAllButton",
            "button.cc-btn.cc-allow",
        ]:
            try:
                btn = await page.query_selector(selector)
                if btn and await btn.is_visible():
                    await btn.click()
                    await page.wait_for_timeout(800)
                    return
            except Exception:
                continue

        for frame in page.frames:
            for selector in [
                "#onetrust-accept-btn-handler",
                '[data-testid="uc-accept-all-button"]',
                'button:has-text("Alle akzeptieren")',
                'button:has-text("Akzeptieren")',
                'button:has-text("Accept all")',
            ]:
                try:
                    btn = await frame.query_selector(selector)
                    if btn and await btn.is_visible():
                        await btn.click()
                        await page.wait_for_timeout(800)
                        return
                except Exception:
                    continue

    @staticmethod
    def _extract_item_id(item: dict, url: str | None) -> str | None:
        for key in ("productID", "sku", "gtin13", "gtin"):
            val = item.get(key)
            if isinstance(val, str) and val.strip():
                return val.strip()

        if not url:
            return None
        try:
            path = urlparse(url).path.strip("/")
        except Exception:
            path = url.strip("/")
        slug = (path.split("/")[-1] if path else "").removesuffix(".html")
        if match := re.search(r"-([a-z]\d+)$", slug, flags=re.IGNORECASE):
            return match.group(1).upper()
        return slug or None

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

    @staticmethod
    def _pick_image_url(image_value: object) -> str | None:
        if isinstance(image_value, str) and image_value.strip():
            return image_value.strip()
        if isinstance(image_value, list) and image_value:
            first = image_value[0]
            if isinstance(first, str) and first.strip():
                return first.strip()
        return None

    @staticmethod
    def _coerce_offer(offers_value: object) -> dict | None:
        if isinstance(offers_value, dict):
            return offers_value
        if isinstance(offers_value, list) and offers_value:
            first = offers_value[0]
            if isinstance(first, dict):
                return first
        return None

    async def extract_products(self, page: Page) -> list[Product]:
        scripts = await page.query_selector_all('script[type="application/ld+json"]')
        catalog: dict | None = None

        for script in scripts:
            try:
                text = (await script.inner_text() or "").strip()
                if not text:
                    continue
                data = json.loads(text)
            except Exception:
                continue

            if isinstance(data, list):
                for obj in data:
                    if isinstance(obj, dict) and "mainEntity" in obj:
                        data = obj
                        break
                else:
                    continue

            if not isinstance(data, dict):
                continue

            main = data.get("mainEntity")
            if isinstance(main, dict) and main.get("@type") == "OfferCatalog" and isinstance(main.get("itemListElement"), list):
                catalog = main
                break

        if not catalog:
            raise RuntimeError("Unable to locate OfferCatalog JSON-LD on page")

        items = catalog.get("itemListElement") or []
        if not isinstance(items, list):
            raise RuntimeError("OfferCatalog.itemListElement is not a list")

        products: list[Product] = []

        for idx, item in enumerate(items):
            if not isinstance(item, dict):
                continue
            try:
                name = (item.get("name") or "").strip() or None

                offers = self._coerce_offer(item.get("offers"))
                url = None
                price = None
                currency = None
                if offers:
                    offer_url = offers.get("url")
                    if isinstance(offer_url, str) and offer_url.strip():
                        url = offer_url.strip()
                    price_val = offers.get("price")
                    if isinstance(price_val, (int, float)):
                        price = float(price_val)
                    elif isinstance(price_val, str) and price_val.strip():
                        try:
                            price = float(price_val.strip())
                        except ValueError:
                            price = None
                    curr_val = offers.get("priceCurrency")
                    if isinstance(curr_val, str) and curr_val.strip():
                        currency = curr_val.strip()

                if not url:
                    item_url = item.get("url")
                    if isinstance(item_url, str) and item_url.strip():
                        url = item_url.strip()

                if url:
                    url = urljoin("https://www.kuebler-sport.de/", url)

                image_url = self._pick_image_url(item.get("image"))
                if image_url:
                    image_url = urljoin("https://www.kuebler-sport.de/", image_url)

                image_bytes, image_mime = await self._fetch_image(page, image_url)

                if not name or not url:
                    continue

                products.append(
                    Product(
                        name=name,
                        price=price,
                        currency=currency,
                        url=url,
                        item_id=self._extract_item_id(item, url),
                        image=image_bytes,
                        image_mime=image_mime,
                    )
                )
            except Exception as e:
                print(f"[{self.name}] Error extracting item {idx}: {e}")

        return products

