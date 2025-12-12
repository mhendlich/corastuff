"""Scraper for artzt.eu product page (Shopify)."""

from __future__ import annotations

import json
import re
from datetime import UTC, datetime
from urllib.parse import parse_qs, urljoin, urlparse

from playwright.async_api import Page

from ..models import Product, ScrapeResult
from ..utils import parse_price
from .base import BaseScraper
from .browser_pool import get_browser_context


class ArtztScraper(BaseScraper):
    """Scrape a single product page from artzt.eu."""

    name = "artzt"
    display_name = "ARTZT"
    url = "https://artzt.eu/en/products/blackroll-standard"

    async def scrape(self) -> ScrapeResult:
        async with get_browser_context() as context:
            page = await context.new_page()
            print(f"[{self.name}] Loading {self.url}...")
            await page.goto(self.url, wait_until="domcontentloaded", timeout=90000)
            await page.wait_for_selector('script[type="application/ld+json"]', timeout=60000, state="attached")
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
    def _pick_image_url(value: object) -> str | None:
        if isinstance(value, str) and value.strip():
            return value.strip()
        if isinstance(value, list) and value:
            first = value[0]
            if isinstance(first, str) and first.strip():
                return first.strip()
        return None

    @staticmethod
    def _coerce_offer(value: object) -> dict | None:
        if isinstance(value, dict):
            return value
        if isinstance(value, list) and value:
            first = value[0]
            if isinstance(first, dict):
                return first
        return None

    @staticmethod
    def _extract_variant_id(url: str | None) -> str | None:
        if not url:
            return None
        try:
            parsed = urlparse(url)
            params = parse_qs(parsed.query)
            v = params.get("variant", [None])[0]
            if isinstance(v, str) and re.fullmatch(r"\d{6,}", v):
                return v
        except Exception:
            pass
        if match := re.search(r"[?&]variant=(\d{6,})", url):
            return match.group(1)
        return None

    @staticmethod
    def _extract_item_id(product: dict, url: str | None) -> str | None:
        for key in ("sku", "gtin", "gtin13", "mpn"):
            val = product.get(key)
            if isinstance(val, str) and val.strip():
                return val.strip()
        if offers := ArtztScraper._coerce_offer(product.get("offers")):
            offer_url = offers.get("url")
            if isinstance(offer_url, str):
                if variant := ArtztScraper._extract_variant_id(offer_url):
                    return variant
        if variant := ArtztScraper._extract_variant_id(url):
            return variant
        return None

    async def _fetch_image(self, page: Page, image_url: str | None) -> tuple[bytes | None, str | None]:
        if not image_url:
            return None, None

        if image_url.startswith("//"):
            image_url = f"https:{image_url}"
        elif image_url.startswith("/"):
            image_url = urljoin("https://artzt.eu/", image_url)

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
        except Exception as img_err:
            print(f"[{self.name}] Failed to fetch image: {img_err}")
            return None, None

    async def _extract_fallback_meta(self, page: Page) -> tuple[str | None, float | None, str | None, str | None]:
        name = None
        price = None
        currency = None
        url = None

        if title_el := await page.query_selector('meta[property="og:title"]'):
            name = await title_el.get_attribute("content")
            name = name.strip() if name else None

        price_text = None
        if price_el := await page.query_selector('meta[property="product:price:amount"]'):
            price_text = await price_el.get_attribute("content")
        if curr_el := await page.query_selector('meta[property="product:price:currency"]'):
            currency = await curr_el.get_attribute("content")
            currency = currency.strip() if currency else None
        if price_text:
            parsed_price, _ = parse_price(price_text)
            price = parsed_price

        if canon_el := await page.query_selector('link[rel="canonical"]'):
            url = await canon_el.get_attribute("href")
        url = (url.strip() if url else None) or page.url
        return name, price, currency, url

    async def extract_products(self, page: Page) -> list[Product]:
        scripts = await page.query_selector_all('script[type="application/ld+json"]')
        product_json: dict | None = None

        for script in scripts:
            try:
                raw = (await script.inner_text() or "").strip()
                if not raw:
                    continue
                data = json.loads(raw)
            except Exception:
                continue

            candidates: list[dict] = []
            if isinstance(data, dict):
                candidates = [data]
            elif isinstance(data, list):
                candidates = [obj for obj in data if isinstance(obj, dict)]

            for obj in candidates:
                if obj.get("@type") == "Product" and (obj.get("name") or obj.get("offers")):
                    product_json = obj
                    break
            if product_json:
                break

        meta_name, meta_price, meta_currency, meta_url = await self._extract_fallback_meta(page)

        name = meta_name
        url = meta_url
        price = meta_price
        currency = meta_currency
        image_url: str | None = None
        item_id: str | None = None

        if product_json:
            json_name = product_json.get("name")
            if isinstance(json_name, str) and json_name.strip():
                name = json_name.strip()

            json_url = product_json.get("url")
            if isinstance(json_url, str) and json_url.strip():
                url = json_url.strip()

            offers = self._coerce_offer(product_json.get("offers"))
            if offers:
                offer_url = offers.get("url")
                if isinstance(offer_url, str) and offer_url.strip():
                    url = offer_url.strip()

                p = offers.get("price")
                if isinstance(p, (int, float)):
                    price = float(p)
                elif isinstance(p, str) and p.strip():
                    try:
                        price = float(p.strip())
                    except ValueError:
                        parsed, _ = parse_price(p)
                        price = parsed

                curr = offers.get("priceCurrency")
                if isinstance(curr, str) and curr.strip():
                    currency = curr.strip()

            image_url = self._pick_image_url(product_json.get("image"))
            item_id = self._extract_item_id(product_json, url)

        if not image_url:
            if og_img := await page.query_selector('meta[property="og:image:secure_url"]'):
                image_url = await og_img.get_attribute("content")
            if not image_url:
                if og_img2 := await page.query_selector('meta[property="og:image"]'):
                    image_url = await og_img2.get_attribute("content")
            image_url = image_url.strip() if isinstance(image_url, str) and image_url.strip() else None

        if url:
            url = urljoin("https://artzt.eu/", url)

        image_bytes, image_mime = await self._fetch_image(page, image_url)

        if not name or not url:
            return []

        return [
            Product(
                name=name,
                price=price,
                currency=currency,
                url=url,
                item_id=item_id,
                image=image_bytes,
                image_mime=image_mime,
            )
        ]

