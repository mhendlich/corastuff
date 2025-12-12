"""Scraper for Globetrotter.de Blackroll products."""

from __future__ import annotations

import re
from urllib.parse import parse_qs, urljoin, urlparse

from playwright.async_api import Page

from ..models import Product
from ..utils import parse_price
from .base import BaseScraper


class GlobetrotterScraper(BaseScraper):
    """Scrape Blackroll products from Globetrotter.de."""

    name = "globetrotter"
    display_name = "Globetrotter"
    url = "https://www.globetrotter.de/marken/blackroll/"

    async def _handle_cookie_consent(self, page: Page) -> None:
        selectors = [
            'button:has-text("Alle akzeptieren")',
            'button:has-text("Akzeptieren")',
            "#onetrust-accept-btn-handler",
            '[data-testid="uc-accept-all-button"]',
            "button#uc-btn-accept-banner",
        ]

        # Consent manager is often embedded in an iframe; try main page first, then frames.
        for selector in selectors:
            try:
                el = await page.query_selector(selector)
                if el and await el.is_visible():
                    await el.click()
                    await page.wait_for_timeout(800)
                    return
            except Exception:
                continue

        for frame in page.frames:
            for selector in selectors:
                try:
                    el = await frame.query_selector(selector)
                    if el and await el.is_visible():
                        await el.click()
                        await page.wait_for_timeout(800)
                        return
                except Exception:
                    continue

    @staticmethod
    def _extract_item_id(url: str | None) -> str | None:
        if not url:
            return None

        try:
            parsed = urlparse(url)
        except Exception:
            parsed = None

        if parsed:
            qs = parse_qs(parsed.query)
            if sku := qs.get("sku", [None])[0]:
                return str(sku)

            path = parsed.path.strip("/")
        else:
            path = url.strip("/")

        if match := re.search(r"-(\d{5,})/?$", path):
            return match.group(1)

        slug = path.split("/")[-1]
        return slug or None

    async def extract_products(self, page: Page) -> list[Product]:
        products: list[Product] = []

        await self._handle_cookie_consent(page)

        await page.wait_for_selector("a.pdpLink[href]", timeout=60000, state="attached")
        await page.wait_for_timeout(800)

        tiles = await page.query_selector_all("a.pdpLink[href]")
        print(f"[{self.name}] Found {len(tiles)} product tiles")

        for idx, tile in enumerate(tiles):
            try:
                href = await tile.get_attribute("href")
                if not href:
                    continue

                url = urljoin("https://www.globetrotter.de", href)

                brand_el = await tile.query_selector(".brand")
                brand = (await brand_el.inner_text()).strip() if brand_el else None

                name_el = await tile.query_selector(".name")
                name = (await name_el.inner_text()).strip() if name_el else None

                if not name:
                    sr_el = await tile.query_selector(".sr-only")
                    name = (await sr_el.inner_text()).strip() if sr_el else None

                if brand and name and brand.lower() not in name.lower():
                    name = f"{brand} {name}"

                price_el = await tile.query_selector(".price")
                price_text = (await price_el.inner_text()).strip() if price_el else None
                price, currency = parse_price(price_text)

                image_bytes = None
                image_mime = None
                image_url = None

                try:
                    await tile.scroll_into_view_if_needed()
                    await page.wait_for_timeout(80)
                except Exception:
                    pass

                img_el = await tile.query_selector("img.js-main-list-image") or await tile.query_selector(
                    "img[src]"
                )
                if img_el:
                    image_url = (
                        await img_el.get_attribute("src")
                        or await img_el.get_attribute("data-src")
                        or await img_el.get_attribute("data-srcset")
                        or await img_el.get_attribute("srcset")
                    )
                    if image_url and "," in image_url:
                        image_url = image_url.split(",")[0].split()[0]

                if image_url:
                    image_url = urljoin("https://www.globetrotter.de", image_url)
                    try:
                        resp = await page.context.request.get(image_url, timeout=30000)
                        if resp.ok:
                            body = await resp.body()
                            if len(body) >= 800:
                                image_bytes = body
                                image_mime = resp.headers.get("content-type")
                                if image_mime and ";" in image_mime:
                                    image_mime = image_mime.split(";", 1)[0].strip()
                    except Exception as img_err:
                        print(f"[{self.name}] Failed to fetch image for tile {idx}: {img_err}")

                if name:
                    products.append(
                        Product(
                            name=name,
                            price=price,
                            currency=currency,
                            url=url,
                            item_id=self._extract_item_id(url),
                            image=image_bytes,
                            image_mime=image_mime,
                        )
                    )

            except Exception as e:
                print(f"[{self.name}] Error extracting product {idx}: {e}")

        return products

