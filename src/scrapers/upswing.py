"""Scraper for Upswing.ch product pages."""

from __future__ import annotations

import json
import re
from datetime import UTC, datetime
from urllib.parse import urljoin

from playwright.async_api import Page

from ..models import Product, ScrapeResult
from ..utils import parse_price
from .base import BaseScraper
from .browser_pool import get_browser_context


class UpswingScraper(BaseScraper):
    """Scrape a product from Upswing.ch."""

    name = "upswing"
    display_name = "Upswing"
    url = "https://www.upswing.ch/BLACKROLL-STANDARD-Hart"

    async def scrape(self) -> ScrapeResult:
        async with get_browser_context() as context:
            page = await context.new_page()

            print(f"[{self.name}] Loading {self.url}...")
            await page.goto(self.url, wait_until="domcontentloaded", timeout=90000)
            await page.wait_for_selector('script[type="application/ld+json"]', state="attached", timeout=60000)
            await page.wait_for_timeout(300)

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
    def _pick_product_json(payload: object) -> dict | None:
        if isinstance(payload, dict):
            if payload.get("@type") == "Product":
                return payload
            return None
        if isinstance(payload, list):
            for item in payload:
                if isinstance(item, dict) and item.get("@type") == "Product":
                    return item
        return None

    @staticmethod
    def _pick_image_url(meta: str | None, product_image: object) -> str | None:
        if meta:
            return meta
        if isinstance(product_image, str) and product_image.strip():
            return product_image.strip()
        if isinstance(product_image, list):
            for item in product_image:
                if isinstance(item, str) and item.strip():
                    return item.strip()
        return None

    async def _fetch_image(self, page: Page, image_url: str | None) -> tuple[bytes | None, str | None]:
        if not image_url:
            return None, None

        if image_url.startswith("//"):
            image_url = f"https:{image_url}"
        elif image_url.startswith("/"):
            image_url = urljoin("https://www.upswing.ch/", image_url)

        try:
            resp = await page.context.request.get(
                image_url,
                timeout=30000,
                headers={"referer": self.url},
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

    async def extract_products(self, page: Page) -> list[Product]:
        products: list[Product] = []

        product_json = None
        for script in await page.query_selector_all('script[type="application/ld+json"]'):
            try:
                raw = (await script.inner_text() or "").strip()
                if not raw:
                    continue
                payload = json.loads(raw)
                product_json = self._pick_product_json(payload)
                if product_json:
                    break
            except Exception:
                continue

        name = None
        url = None
        item_id = None
        price = None
        currency = None
        image_url = None

        if product_json:
            name = self._coerce_str(product_json.get("name"))
            url = self._coerce_str(product_json.get("url")) or self._coerce_str(page.url)
            pid = product_json.get("productID") or product_json.get("sku")
            item_id = self._coerce_str(str(pid)) if pid is not None else None

            offers = product_json.get("offers")
            if isinstance(offers, list) and offers:
                offers = offers[0]
            if isinstance(offers, dict):
                offer_price = offers.get("price")
                if isinstance(offer_price, (int, float)):
                    price = float(offer_price)
                elif isinstance(offer_price, str):
                    parsed, _currency = parse_price(offer_price)
                    price = parsed
                currency = self._coerce_str(offers.get("priceCurrency"))

            image_url = self._pick_image_url(None, product_json.get("image"))

        if not name:
            if og_title := await page.query_selector('meta[property="og:title"]'):
                name = self._coerce_str(await og_title.get_attribute("content"))
                if name:
                    name = re.sub(r",\\s*CHF\\s*[\\d.,]+\\s*$", "", name).strip() or name

        if not url:
            url = self._coerce_str(page.url) or self.url

        if price is None or not currency:
            if price_el := await page.query_selector('[itemprop="price"]'):
                raw_price = (
                    await price_el.get_attribute("content")
                    or self._coerce_str(await price_el.inner_text())
                )
                parsed_price, parsed_currency = parse_price(raw_price)
                price = price if price is not None else parsed_price
                currency = currency or parsed_currency
            if currency is None:
                if curr_el := await page.query_selector('[itemprop="priceCurrency"]'):
                    currency = self._coerce_str(await curr_el.get_attribute("content"))

        if og_img := await page.query_selector('meta[property="og:image"]'):
            image_url = self._coerce_str(await og_img.get_attribute("content")) or image_url
        if not image_url and (itemprop_img := await page.query_selector('[itemprop="image"]')):
            image_url = self._coerce_str(await itemprop_img.get_attribute("content")) or self._coerce_str(
                await itemprop_img.get_attribute("src")
            )

        image_bytes, image_mime = await self._fetch_image(page, image_url)

        if name:
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

        return products

