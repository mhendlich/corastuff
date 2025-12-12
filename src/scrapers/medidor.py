"""Scraper for medidor.ch Blackroll vendor page (Shopify)."""

from __future__ import annotations

import json
import re
from urllib.parse import urljoin

from playwright.async_api import Page

from ..models import Product
from ..utils import parse_price
from .base import BaseScraper


class MedidorScraper(BaseScraper):
    """Scrape Blackroll products from medidor.ch (Shopify)."""

    name = "medidor"
    display_name = "MEDiDOR (Blackroll)"
    url = "https://medidor.ch/en/collections/vendors?q=blackroll"

    user_agent = (
        "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 "
        "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"
    )
    locale = "en-CH"
    viewport = {"width": 1920, "height": 1080}
    init_scripts = [
        """
        Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
        """.strip()
    ]

    _base_url = "https://medidor.ch"

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

    async def _infer_currency(self, page: Page) -> str | None:
        try:
            html = await page.content()
        except Exception:
            return None

        match = re.search(r"Shopify\\.currency\\s*=\\s*(\\{[^;]+\\})", html)
        if not match:
            return None
        try:
            payload = json.loads(match.group(1))
        except Exception:
            return None

        active = payload.get("active")
        if isinstance(active, str) and re.fullmatch(r"[A-Z]{3}", active.strip()):
            return active.strip()
        return None

    async def _extract_product_handles(self, page: Page) -> list[str]:
        await page.wait_for_selector("a.product-thumbnail__title[href]", timeout=60000)
        links = await page.query_selector_all("a.product-thumbnail__title[href]")

        handles: list[str] = []
        seen: set[str] = set()
        for el in links:
            href = await el.get_attribute("href")
            if not href:
                continue
            match = re.search(r"/products/([^/?#]+)", href)
            if not match:
                continue
            handle = match.group(1).strip()
            if not handle or handle in seen:
                continue
            seen.add(handle)
            handles.append(handle)

        if not handles:
            # Fallback: theme sometimes embeds product URLs in JS maps.
            try:
                html = await page.content()
            except Exception:
                return []
            for handle in re.findall(r"/en/products/([a-z0-9-]+)", html):
                if handle not in seen:
                    seen.add(handle)
                    handles.append(handle)

        return handles

    @staticmethod
    def _best_price(product: dict) -> float | None:
        variants = product.get("variants")
        if not isinstance(variants, list):
            return None

        prices: list[float] = []
        for v in variants:
            if not isinstance(v, dict):
                continue
            amount, _ = parse_price(str(v.get("price") or ""))
            if amount is not None:
                prices.append(amount)
        return min(prices) if prices else None

    @staticmethod
    def _pick_best_image_url(product: dict) -> str | None:
        images = product.get("images")
        if isinstance(images, list) and images:
            best: dict | None = None
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

        image = product.get("image")
        if isinstance(image, dict):
            src = image.get("src")
            return src if isinstance(src, str) and src.strip() else None
        return None

    async def _fetch_image(self, page: Page, image_url: str | None, *, referer: str) -> tuple[bytes | None, str | None]:
        image_url = self._normalize_url(self._base_url, image_url)
        if not image_url:
            return None, None

        try:
            resp = await page.context.request.get(
                image_url,
                headers={
                    "Accept": "image/webp,image/apng,image/*,*/*;q=0.8",
                    "Referer": referer,
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
        except Exception:
            return None, None

    async def _fetch_product_json(self, page: Page, handle: str) -> dict | None:
        json_url = f"{self._base_url}/en/products/{handle}.json"
        resp = await page.context.request.get(
            json_url,
            headers={"Accept": "application/json", "Referer": self.url},
            timeout=45000,
        )
        if not resp.ok:
            return None
        payload = await resp.json()
        product = payload.get("product") if isinstance(payload, dict) else None
        return product if isinstance(product, dict) else None

    async def extract_products(self, page: Page) -> list[Product]:
        currency = await self._infer_currency(page) or "CHF"
        handles = await self._extract_product_handles(page)
        print(f"[{self.name}] Found {len(handles)} product handle(s)")

        products: list[Product] = []
        for handle in handles:
            try:
                product = await self._fetch_product_json(page, handle)
                if not product:
                    continue

                title = (product.get("title") or "").strip()
                if not title:
                    continue

                product_url = f"{self._base_url}/en/products/{handle}"
                item_id = str(product.get("id") or handle)
                price = self._best_price(product)

                image_url = self._pick_best_image_url(product)
                image_bytes, image_mime = await self._fetch_image(page, image_url, referer=product_url)

                products.append(
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
            except Exception as e:
                print(f"[{self.name}] Failed to parse product {handle}: {e}")

        return products

