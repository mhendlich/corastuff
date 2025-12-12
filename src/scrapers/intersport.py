"""Scraper for Intersport.de Blackroll products."""

from __future__ import annotations

from datetime import datetime, UTC
import re
from urllib.parse import parse_qs, urljoin, urlparse

from playwright.async_api import Page, async_playwright

from ..models import Product, ScrapeResult
from ..utils import parse_price
from .base import BaseScraper


class IntersportScraper(BaseScraper):
    """Scrape Blackroll products from Intersport.de."""

    name = "intersport"
    display_name = "Intersport"
    url = "https://www.intersport.de/d/marken/blackroll"

    async def scrape(self) -> ScrapeResult:
        async with async_playwright() as p:
            browser = await p.chromium.launch(
                headless=True,
                args=[
                    "--disable-blink-features=AutomationControlled",
                    "--no-sandbox",
                ],
            )
            context = await browser.new_context(
                viewport={"width": 1920, "height": 1080},
                locale="de-DE",
                user_agent=(
                    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 "
                    "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"
                ),
            )
            page = await context.new_page()

            print(f"[{self.name}] Loading {self.url}...")
            try:
                await page.goto(self.url, wait_until="domcontentloaded", timeout=90000)
            except Exception as e:
                print(f"[{self.name}] Initial load error: {e}, continuing...")

            products = await self.extract_products(page)
            print(f"[{self.name}] Extracted {len(products)} products")

            await browser.close()

            return ScrapeResult(
                source=self.name,
                source_url=self.url,
                scraped_at=datetime.now(UTC),
                products=products,
            )

    @staticmethod
    def _pick_srcset_url(srcset: str | None) -> str | None:
        if not srcset:
            return None
        # srcset candidates are comma+whitespace separated; URLs themselves may contain commas.
        candidates = [c.strip() for c in re.split(r",\\s+", srcset.strip()) if c.strip()]
        if not candidates:
            return None
        return candidates[-1].split()[0]

    async def _handle_cookie_consent(self, page: Page) -> None:
        for selector in [
            'button:has-text("Alle akzeptieren")',
            'button:has-text("Akzeptieren")',
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

    async def extract_products(self, page: Page) -> list[Product]:
        products: list[Product] = []

        await self._handle_cookie_consent(page)
        await page.wait_for_selector('[data-testid="product-tile"]', timeout=60000, state="attached")
        await page.wait_for_timeout(1500)

        tiles = await page.query_selector_all('[data-testid="product-tile"]')
        print(f"[{self.name}] Found {len(tiles)} product tiles")

        for idx, tile in enumerate(tiles):
            try:
                link = await tile.query_selector('a[href^="/p/"]') or await tile.query_selector("a[href]")
                href = await link.get_attribute("href") if link else None
                if not href:
                    continue

                url = urljoin("https://www.intersport.de", href)

                img = await tile.query_selector("img[alt]") or await tile.query_selector("img")
                name = None
                if img:
                    alt = await img.get_attribute("alt")
                    if alt:
                        name = alt.strip()
                if not name and link:
                    name = (await link.get_attribute("title")) or None
                if not name and link:
                    aria = await link.get_attribute("aria-label")
                    if aria and "von " in aria:
                        name = aria.split("von ", 1)[-1].strip()

                lines = [ln.strip() for ln in (await tile.inner_text()).splitlines() if ln.strip() and ln.strip() != "*"]
                brand = lines[0] if lines else None
                if brand and name and brand.lower() not in name.lower():
                    name = f"{brand} {name}"

                price_text = None
                if price_el := await tile.query_selector('[data-testid="pulse-product-price"]'):
                    price_text = (await price_el.inner_text()).strip()
                price, currency = parse_price(price_text)

                item_id = None
                try:
                    parsed = urlparse(url)
                    item_id = parse_qs(parsed.query).get("articleId", [None])[0]
                except Exception:
                    item_id = None

                image_bytes = None
                image_mime = None
                image_url = None

                if img:
                    image_url = (
                        await img.get_attribute("src")
                        or await img.get_attribute("data-src")
                        or self._pick_srcset_url(await img.get_attribute("srcset"))
                        or self._pick_srcset_url(await img.get_attribute("data-srcset"))
                    )

                if image_url:
                    image_url = urljoin("https://www.intersport.de", image_url)
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
                            item_id=item_id,
                            image=image_bytes,
                            image_mime=image_mime,
                        )
                    )

            except Exception as e:
                print(f"[{self.name}] Error extracting product {idx}: {e}")

        return products
