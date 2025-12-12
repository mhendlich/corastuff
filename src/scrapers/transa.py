"""Scraper for Transa.ch Blackroll products."""

from __future__ import annotations

from datetime import datetime, UTC
from urllib.parse import urljoin, urlparse
import re

from playwright.async_api import Page

from ..models import Product, ScrapeResult
from ..utils import parse_price
from .base import BaseScraper
from .browser_pool import get_browser_context


class TransaScraper(BaseScraper):
    """Scrape Blackroll products from Transa.ch."""

    name = "transa"
    display_name = "Transa"
    url = "https://www.transa.ch/de/b/blackroll/"

    async def scrape(self) -> ScrapeResult:
        async with get_browser_context() as context:
            page = await context.new_page()

            print(f"[{self.name}] Loading {self.url}...")
            await page.goto(self.url, wait_until="domcontentloaded", timeout=90000)
            await self._handle_cookie_consent(page)

            await page.wait_for_selector("li.ProductCardGridItem", timeout=60000, state="attached")
            await page.wait_for_timeout(800)
            await self._ensure_all_products_loaded(page)

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
            "#CybotCookiebotDialogBodyLevelButtonLevelOptinAllowAll",
            'button:has-text("Alle akzeptieren")',
            'button:has-text("Akzeptieren")',
            'button:has-text("Accept all")',
            'button:has-text("Allow all")',
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

    async def _ensure_all_products_loaded(self, page: Page) -> None:
        stable_rounds = 0
        last_count = -1
        for _ in range(10):
            cards = await page.query_selector_all("li.ProductCardGridItem")
            count = len(cards)
            if count == last_count:
                stable_rounds += 1
            else:
                stable_rounds = 0
            if stable_rounds >= 2:
                return
            last_count = count

            try:
                await page.evaluate("window.scrollTo(0, document.body.scrollHeight)")
            except Exception:
                pass
            await page.wait_for_timeout(600)

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
        slug = path.split("/")[-1].strip()
        slug = slug[:-1] if slug.endswith("/") else slug
        if match := re.search(r"-(\d+(?:-\d+)+)$", slug):
            return match.group(1)
        return slug or None

    @staticmethod
    def _pick_image_url(src: str | None, srcset: str | None) -> str | None:
        if srcset:
            parts = [p.strip().split(" ")[0] for p in srcset.split(",") if p.strip()]
            if parts:
                return parts[-1]
        return src

    async def extract_products(self, page: Page) -> list[Product]:
        products: list[Product] = []

        product_elements = await page.query_selector_all("li.ProductCardGridItem")
        print(f"[{self.name}] Found {len(product_elements)} product elements")

        for idx, el in enumerate(product_elements):
            try:
                await el.scroll_into_view_if_needed()
                await page.wait_for_timeout(100)

                brand_el = await el.query_selector(".ProductCard--brand")
                brand = (await brand_el.inner_text()).strip() if brand_el else None

                name_el = await el.query_selector(".ProductCard--name")
                name = (await name_el.inner_text()).strip() if name_el else None
                if brand and name and brand.lower() not in name.lower():
                    name = f"{brand} {name}"

                price_el = await el.query_selector(".ProductPrice--current")
                if not price_el:
                    price_el = await el.query_selector(".ProductCard--prices")
                price_text = (await price_el.inner_text()).strip() if price_el else None
                price, currency = parse_price(price_text)

                url = None
                link_el = await el.query_selector("a.ProductCard--link")
                if link_el:
                    url = await link_el.get_attribute("href")
                if url:
                    url = urljoin("https://www.transa.ch", url)

                item_id = self._extract_item_id(url)

                image_bytes = None
                image_mime = None
                image_url = None
                img_el = await el.query_selector(".ProductCard--imageWrapper img, .ProductCard--image img, img")
                if img_el:
                    src = await img_el.get_attribute("src")
                    srcset = await img_el.get_attribute("srcset")
                    image_url = self._pick_image_url(src, srcset)

                if image_url:
                    image_url = urljoin("https://www.transa.ch", image_url)
                    try:
                        resp = await page.context.request.get(image_url)
                        if resp.ok:
                            image_bytes = await resp.body()
                            image_mime = resp.headers.get("content-type")
                            if image_mime and ";" in image_mime:
                                image_mime = image_mime.split(";", 1)[0].strip()
                    except Exception as img_err:
                        print(f"[{self.name}] Failed to fetch image for {name}: {img_err}")

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

