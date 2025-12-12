"""Scraper for sport-bittl.com Blackroll products."""

from __future__ import annotations

import re
from datetime import UTC, datetime
from urllib.parse import urljoin

from playwright.async_api import Page

from ..models import Product, ScrapeResult
from ..utils import parse_price
from .base import BaseScraper
from .browser_pool import get_browser_context


_STEALTH_INIT_SCRIPT = """
Object.defineProperty(navigator, 'webdriver', {get: () => undefined});
Object.defineProperty(navigator, 'languages', {get: () => ['en-US','en']});
Object.defineProperty(navigator, 'plugins', {get: () => [1,2,3,4,5]});
""".strip()


class SportBittlScraper(BaseScraper):
    """Scrape Blackroll products from sport-bittl.com (Findologic listing)."""

    name = "sport_bittl"
    display_name = "Sport Bittl"
    url = "https://www.sport-bittl.com/en/fitness-accessories/blackroll/"

    async def scrape(self) -> ScrapeResult:
        async with get_browser_context(
            user_agent=(
                "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 "
                "(KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36"
            ),
            locale="en-US",
            viewport={"width": 1365, "height": 768},
            init_scripts=[_STEALTH_INIT_SCRIPT],
        ) as context:
            page = await context.new_page()
            print(f"[{self.name}] Loading {self.url}...")

            await page.goto(self.url, wait_until="domcontentloaded", timeout=90000)
            await self._wait_for_security_challenge(page)
            await self._handle_cookie_consent(page)

            await page.wait_for_selector(".fl-product", timeout=60000, state="attached")
            await page.wait_for_timeout(1200)

            products = await self.extract_products(page)
            print(f"[{self.name}] Extracted {len(products)} products")

        return ScrapeResult(
            source=self.name,
            source_url=self.url,
            scraped_at=datetime.now(UTC),
            products=products,
        )

    async def _wait_for_security_challenge(self, page: Page) -> None:
        # sport-bittl uses Bunny Shield; wait until the real page title appears.
        for _ in range(90):
            await page.wait_for_timeout(1000)
            try:
                title = await page.title()
            except Exception:
                continue
            if "Establishing a secure connection" not in title:
                return
        # If we get here, keep going; downstream waits will error with context.

    async def _handle_cookie_consent(self, page: Page) -> None:
        # sport-bittl uses a custom cookie modal ("vbcn").
        for selector in [
            ".js-vbcn-accept",
            'button:has-text("Accept")',
            'button:has-text("Accept all")',
            "#onetrust-accept-btn-handler",
            '[data-testid="uc-accept-all-button"]',
        ]:
            try:
                btn = await page.query_selector(selector)
                if btn and await btn.is_visible():
                    await btn.click()
                    await page.wait_for_timeout(800)
                    return
            except Exception:
                continue

    @staticmethod
    def _extract_item_id(url: str | None, fallback: str | None = None) -> str | None:
        if fallback and str(fallback).strip():
            return str(fallback).strip()
        if not url:
            return None
        if match := re.search(r"::(\\d+)\\.html$", url):
            return match.group(1)
        return None

    async def _fetch_image(self, page: Page, image_url: str | None) -> tuple[bytes | None, str | None]:
        if not image_url:
            return None, None
        try:
            resp = await page.context.request.get(
                image_url,
                timeout=30000,
                headers={
                    # sport-bittl serves a Bunny Shield HTML challenge unless the request
                    # resembles a real <img> fetch.
                    "Accept": "image/avif,image/webp,image/apng,image/*,*/*;q=0.8",
                    "Referer": page.url,
                    "Sec-Fetch-Dest": "image",
                    "Sec-Fetch-Mode": "no-cors",
                    "Sec-Fetch-Site": "same-origin",
                },
            )
            if not resp.ok:
                return None, None
            body = await resp.body()
            if len(body) < 800:
                return None, None
            mime = resp.headers.get("content-type")
            if mime and ";" in mime:
                mime = mime.split(";", 1)[0].strip()
            if mime and not mime.startswith("image/"):
                return None, None
            return body, mime
        except Exception:
            return None, None

    async def extract_products(self, page: Page) -> list[Product]:
        products: list[Product] = []

        tiles = await page.query_selector_all(".fl-product")
        print(f"[{self.name}] Found {len(tiles)} product tiles")

        for idx, tile in enumerate(tiles):
            try:
                await tile.scroll_into_view_if_needed()
                await page.wait_for_timeout(80)

                url = await tile.get_attribute("data-link")
                if not url:
                    if link := await tile.query_selector("a.fl-product-image-link[href]"):
                        url = await link.get_attribute("href")
                if url:
                    url = urljoin("https://www.sport-bittl.com", url)

                item_id = self._extract_item_id(url, await tile.get_attribute("data-product-id"))

                brand = None
                if brand_el := await tile.query_selector(".fl-product-brand"):
                    brand = (await brand_el.inner_text()).strip() or None

                name = None
                if link := await tile.query_selector("a[data-fl-item-name]"):
                    name = (await link.get_attribute("data-fl-item-name")) or None
                if not name:
                    if name_el := await tile.query_selector(".fl-product-name"):
                        name = (await name_el.inner_text()).strip() or None
                if brand and name and brand.lower() not in name.lower():
                    name = f"{brand} {name}"

                price_text = None
                if price_el := await tile.query_selector(".fl-price"):
                    price_text = (await price_el.inner_text()).strip() or None
                price, currency = parse_price(price_text)

                image_url = None
                if img := await tile.query_selector("img.fl-product-image-img, img"):
                    image_url = (
                        await img.get_attribute("src")
                        or await img.get_attribute("data-src")
                        or await img.get_attribute("srcset")
                        or await img.get_attribute("data-srcset")
                    )
                    if image_url and "," in image_url:
                        image_url = image_url.split(",")[0].split()[0]
                if image_url:
                    image_url = urljoin("https://www.sport-bittl.com", image_url)

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
            except Exception as e:
                print(f"[{self.name}] Error extracting product {idx}: {e}")

        return products
