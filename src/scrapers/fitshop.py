"""Scraper for Fitshop.de Blackroll products."""

from __future__ import annotations

import re
from datetime import datetime, UTC
from urllib.parse import urljoin, urlparse

from playwright.async_api import Page

from ..models import Product, ScrapeResult
from ..utils import parse_price
from .base import BaseScraper
from .browser_pool import get_browser_context


class FitshopScraper(BaseScraper):
    """Scrape Blackroll products from Fitshop.de."""

    name = "fitshop"
    display_name = "Fitshop"
    url = "https://www.fitshop.de/blackroll-faszientraining-faszienrollen"

    async def scrape(self) -> ScrapeResult:
        async with get_browser_context() as context:
            page = await context.new_page()

            print(f"[{self.name}] Loading {self.url}...")
            try:
                await page.goto(self.url, wait_until="domcontentloaded", timeout=90000)
            except Exception as e:
                print(f"[{self.name}] Initial load error: {e}, continuing...")

            await self._handle_cookie_consent(page)
            await page.wait_for_timeout(1200)

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
            "#onetrust-accept-btn-handler",
            '[data-testid="uc-accept-all-button"]',
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

    @staticmethod
    def _extract_item_id(url: str | None) -> str | None:
        if not url:
            return None
        try:
            path = urlparse(url).path.strip("/")
        except Exception:
            path = url.strip("/")
        if not path:
            return None
        slug = path.split("/")[-1]
        if match := re.search(r"(br-[0-9a-z]+)$", slug, flags=re.IGNORECASE):
            return match.group(1).lower()
        return slug

    async def extract_products(self, page: Page) -> list[Product]:
        products: list[Product] = []

        await page.wait_for_selector("li.product-list-entry", timeout=60000, state="attached")
        await page.wait_for_timeout(800)

        items = await page.query_selector_all("li.product-list-entry")
        print(f"[{self.name}] Found {len(items)} product entries")

        for idx, item in enumerate(items):
            try:
                link_el = await item.query_selector(".title-wrapper a[href]") or await item.query_selector(
                    "a.product-click[href]"
                )
                href = await link_el.get_attribute("href") if link_el else None
                url = urljoin("https://www.fitshop.de", href) if href else None

                name = None
                if link_el:
                    name = (await link_el.inner_text()).strip() or None

                price_text = None
                if price_el := await item.query_selector(".price-now"):
                    price_text = (await price_el.inner_text()).strip()
                price, currency = parse_price(price_text)

                image_bytes = None
                image_mime = None
                image_url = None

                try:
                    await item.scroll_into_view_if_needed()
                    await page.wait_for_timeout(100)
                except Exception:
                    pass

                img_el = await item.query_selector(".image-wrapper img")
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
                    image_url = urljoin("https://www.fitshop.de", image_url)
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
                        print(f"[{self.name}] Failed to fetch image for item {idx}: {img_err}")

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

