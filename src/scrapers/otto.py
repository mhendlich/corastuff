"""Scraper for OTTO.de Blackroll products."""

from __future__ import annotations

import asyncio
import concurrent.futures
from datetime import datetime, UTC

import requests
from bs4 import BeautifulSoup
from playwright.async_api import Page

from ..models import Product, ScrapeResult
from ..utils import parse_price
from .base import BaseScraper


class OttoScraper(BaseScraper):
    """Scrape Blackroll products from OTTO.de."""

    name = "otto"
    display_name = "OTTO"
    url = "https://www.otto.de/sport/?marke=blackroll"

    async def scrape(self) -> ScrapeResult:
        """Run the scraper using requests (OTTO renders product tiles server-side)."""
        products = await asyncio.to_thread(self._scrape_sync)
        print(f"[{self.name}] Extracted {len(products)} products")
        return ScrapeResult(
            source=self.name,
            source_url=self.url,
            scraped_at=datetime.now(UTC),
            products=products,
        )

    async def extract_products(self, page: Page) -> list[Product]:
        """Extract products from a Playwright page (fallback path)."""
        return self._parse_html(await page.content(), fetch_images=False)

    def _scrape_sync(self) -> list[Product]:
        html = self._fetch_html(self.url)
        return self._parse_html(html, fetch_images=True)

    def _fetch_html(self, url: str) -> str:
        resp = requests.get(
            url,
            timeout=45,
            headers={
                "User-Agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36",
                "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
                "Accept-Language": "de-DE,de;q=0.9,en-US;q=0.8,en;q=0.7",
            },
        )
        resp.raise_for_status()
        return resp.text

    def _fetch_tile_html(self, tile_url: str) -> str:
        if tile_url.startswith("/"):
            tile_url = f"https://www.otto.de{tile_url}"
        resp = requests.get(
            tile_url,
            timeout=30,
            headers={
                "User-Agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36",
                "Referer": self.url,
                "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
                "Accept-Language": "de-DE,de;q=0.9,en-US;q=0.8,en;q=0.7",
            },
        )
        resp.raise_for_status()
        return resp.text

    @staticmethod
    def _pick_srcset_url(srcset: str | None) -> str | None:
        if not srcset:
            return None
        # srcset: "url1 1x, url2 2x" or "url 800w"
        candidates = [c.strip() for c in srcset.split(",") if c.strip()]
        if not candidates:
            return None
        # Prefer the last candidate (often the largest).
        return candidates[-1].split()[0]

    def _extract_image_url(self, article) -> str | None:
        # Prefer webp sources when available.
        for selector in ('source[type="image/webp"][srcset]', "source[srcset]"):
            source = article.select_one(selector)
            if source and source.get("srcset"):
                url = self._pick_srcset_url(source.get("srcset"))
                if url:
                    return url

        img = article.select_one("img")
        if not img:
            return None
        url = (
            img.get("src")
            or img.get("data-src")
            or self._pick_srcset_url(img.get("srcset"))
            or self._pick_srcset_url(img.get("data-srcset"))
        )
        return url

    def _extract_tile_url(self, article) -> str | None:
        tile = article.get("data-href")
        if tile:
            return tile
        nested = article.select_one('[data-href^="/crocotile/tile/"]')
        if nested:
            return nested.get("data-href")
        return None

    def _parse_tile_html(self, html: str) -> tuple[str | None, float | None, str | None, str | None, str | None]:
        """Return (name, price, currency, product_url, image_url) from a crocotile HTML snippet."""
        soup = BeautifulSoup(html, "lxml")

        product_url = None
        if a := soup.select_one('a[href^="/p/"]'):
            href = a.get("href")
            if href:
                product_url = href if href.startswith("http") else f"https://www.otto.de{href}"

        image_url = self._extract_image_url(soup)

        name = None
        img = soup.select_one("img[alt]")
        if img and img.get("alt"):
            name = img.get("alt").strip()

        price_text = None
        if price_el := soup.select_one(".find_tile__retailPrice, .find_tile__priceValue"):
            price_text = price_el.get_text(" ", strip=True)
        price, currency = parse_price(price_text)

        return name, price, currency, product_url, image_url

    def _fetch_image(self, image_url: str) -> tuple[bytes | None, str | None]:
        if not image_url:
            return None, None
        if "lh_platzhalter_ohne_abbildung" in image_url:
            return None, None

        headers = {
            "User-Agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36",
            "Referer": self.url,
            "Accept": "image/avif,image/webp,image/apng,image/*,*/*;q=0.8",
        }
        resp = requests.get(image_url, headers=headers, timeout=30)
        if not resp.ok:
            return None, None

        content_type = resp.headers.get("content-type")
        if content_type and ";" in content_type:
            content_type = content_type.split(";", 1)[0].strip()

        # Basic sanity check to avoid storing tiny error/placeholder images.
        if len(resp.content) < 800:
            return None, None

        return resp.content, content_type

    def _parse_html(self, html: str, *, fetch_images: bool) -> list[Product]:
        soup = BeautifulSoup(html, "lxml")
        products_with_assets: list[tuple[Product, str | None, str | None]] = []

        for article in soup.select("article.product"):
            try:
                item_id = (
                    article.get("data-variation-id")
                    or article.get("data-article-number")
                    or article.get("data-product-id")
                    or article.get("data-id")
                )

                a = article.select_one('a[href^="/p/"]')
                url = None
                if a and a.get("href"):
                    url = a["href"]
                    if url.startswith("/"):
                        url = f"https://www.otto.de{url}"

                img = article.select_one("img[alt]")
                name = img.get("alt").strip() if img and img.get("alt") else None
                if not name:
                    # Fallback: pick the longest visible line from the tile.
                    lines = [t.strip() for t in article.get_text("\n").split("\n") if t.strip()]
                    if lines:
                        name = max(lines, key=len)

                price_text = None
                price_el = article.select_one(".find_tile__retailPrice, .find_tile__priceValue")
                if price_el:
                    price_text = price_el.get_text(" ", strip=True)
                price, currency = parse_price(price_text)

                if name:
                    image_url = self._extract_image_url(article)
                    tile_url = self._extract_tile_url(article)
                    products_with_assets.append(
                        (
                        Product(
                            name=name,
                            price=price,
                            currency=currency,
                            url=url,
                            item_id=item_id,
                            image=None,
                            image_mime=None,
                        ),
                        image_url,
                        tile_url,
                        )
                    )
            except Exception as e:
                print(f"[{self.name}] Error parsing product tile: {e}")

        if fetch_images and products_with_assets:
            # Fetch missing tile HTML + download images in parallel.
            def fetch_assets(image_url: str | None, tile_url: str | None) -> tuple[bytes | None, str | None, str | None, float | None, str | None, str | None]:
                try:
                    resolved_image_url = image_url
                    resolved_name = None
                    resolved_price = None
                    resolved_currency = None
                    resolved_product_url = None

                    if not resolved_image_url and tile_url:
                        tile_html = self._fetch_tile_html(tile_url)
                        (
                            resolved_name,
                            resolved_price,
                            resolved_currency,
                            resolved_product_url,
                            resolved_image_url,
                        ) = self._parse_tile_html(tile_html)

                    if resolved_image_url:
                        image_bytes, image_mime = self._fetch_image(resolved_image_url)
                        return (
                            image_bytes,
                            image_mime,
                            resolved_name,
                            resolved_price,
                            resolved_currency,
                            resolved_product_url,
                        )
                    return None, None, resolved_name, resolved_price, resolved_currency, resolved_product_url
                except Exception:
                    return None, None, None, None, None, None

            with concurrent.futures.ThreadPoolExecutor(max_workers=10) as pool:
                future_by_index: dict[concurrent.futures.Future, int] = {}
                for idx, (product, image_url, tile_url) in enumerate(products_with_assets):
                    if image_url or tile_url:
                        future_by_index[pool.submit(fetch_assets, image_url, tile_url)] = idx

                for future in concurrent.futures.as_completed(future_by_index):
                    idx = future_by_index[future]
                    image_bytes, image_mime, name, price, currency, product_url = future.result()
                    if image_bytes:
                        product, _, _ = products_with_assets[idx]
                        product.image = image_bytes
                        product.image_mime = image_mime
                    if name or price is not None or currency or product_url:
                        product, _, _ = products_with_assets[idx]
                        if name:
                            product.name = name
                        if price is not None:
                            product.price = price
                        if currency:
                            product.currency = currency
                        if product_url:
                            product.url = product_url

        return [p for p, _, _ in products_with_assets]
