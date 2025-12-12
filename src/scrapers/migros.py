"""Scraper for Migros Online Blackroll brand page."""

from __future__ import annotations

import re
from datetime import UTC, datetime
from urllib.parse import urljoin

from playwright.async_api import Page

from ..models import Product, ScrapeResult
from .base import BaseScraper
from .browser_pool import get_browser_context


class MigrosScraper(BaseScraper):
    """Scrape Blackroll products from migros.ch brand page."""

    name = "migros"
    display_name = "Migros"
    url = "https://www.migros.ch/en/brand/blackroll"

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

    _base_url = "https://www.migros.ch"
    _currency = "CHF"

    async def scrape(self) -> ScrapeResult:
        async with get_browser_context(
            user_agent=self.user_agent,
            locale=self.locale,
            viewport=self.viewport,
            init_scripts=self.init_scripts,
        ) as context:
            page = await context.new_page()
            print(f"[{self.name}] Loading {self.url}...")
            await page.goto(self.url, wait_until="domcontentloaded", timeout=90000)
            await page.wait_for_selector('article[data-testid^="product-card-"]', timeout=90000, state="attached")

            products = await self.extract_products(page)
            print(f"[{self.name}] Extracted {len(products)} products")

        return ScrapeResult(
            source=self.name,
            source_url=self.url,
            scraped_at=datetime.now(UTC),
            products=products,
        )

    @staticmethod
    def _pick_srcset_best(srcset: str | None) -> str | None:
        if not srcset or not isinstance(srcset, str):
            return None
        parts = [p.strip() for p in srcset.split(",") if p.strip()]
        if not parts:
            return None
        # Use the last entry (usually the largest width).
        best = parts[-1].split()[0].strip()
        return best or None

    async def _fetch_image(self, page: Page, image_url: str | None) -> tuple[bytes | None, str | None]:
        if not image_url:
            return None, None

        image_url = image_url.strip()
        if image_url.startswith("//"):
            image_url = f"https:{image_url}"
        elif image_url.startswith("/"):
            image_url = urljoin(self._base_url, image_url)

        try:
            resp = await page.context.request.get(
                image_url,
                headers={
                    "Accept": "image/avif,image/webp,image/apng,image/*,*/*;q=0.8",
                    "Referer": self.url,
                    "Sec-Fetch-Dest": "image",
                    "Sec-Fetch-Mode": "no-cors",
                    "Sec-Fetch-Site": "same-site",
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
        except Exception as img_err:
            print(f"[{self.name}] Failed to fetch image: {img_err}")
            return None, None

    @staticmethod
    def _extract_item_id_from_href(href: str | None) -> str | None:
        if not href or not isinstance(href, str):
            return None
        if match := re.search(r"/product/(\\d{6,})", href):
            return match.group(1)
        return None

    async def extract_products(self, page: Page) -> list[Product]:
        products: list[Product] = []

        # The listing can lazily render; scroll a bit to ensure all cards are in DOM.
        last_count = -1
        for _ in range(8):
            cards = await page.query_selector_all('article[data-testid^="product-card-"]')
            if len(cards) == last_count:
                break
            last_count = len(cards)
            try:
                await page.evaluate("window.scrollTo(0, document.body.scrollHeight)")
            except Exception:
                pass
            await page.wait_for_timeout(700)

        cards = await page.query_selector_all('article[data-testid^="product-card-"]')
        print(f"[{self.name}] Found {len(cards)} product cards")

        for idx, card in enumerate(cards):
            try:
                href = None
                link_el = await card.query_selector('a[href^="/en/product/"]')
                if link_el:
                    href = await link_el.get_attribute("href")
                url = urljoin(self._base_url, href) if href else None
                item_id = self._extract_item_id_from_href(href) or None

                name_el = await card.query_selector('[data-testid^="product-name-"]')
                name = (" ".join((await name_el.inner_text()).split()) if name_el else "").strip()
                if not name:
                    # Fallback: card has a useful aria-label
                    aria = await card.get_attribute("aria-label")
                    name = aria.strip() if isinstance(aria, str) else ""
                if not name:
                    continue

                size_el = await card.query_selector('[data-testid="default-product-size"]')
                size = (" ".join((await size_el.inner_text()).split()) if size_el else "").strip()
                if size and size.lower() not in name.lower():
                    name = f"{name} {size}"

                price: float | None = None
                price_el = await card.query_selector('[data-testid="current-price"]')
                if price_el:
                    raw = (" ".join((await price_el.inner_text()).split()) if price_el else "").strip()
                    try:
                        price = float(raw.replace("'", "").replace(",", "."))
                    except Exception:
                        price = None

                img_el = await card.query_selector("img[src], img[srcset]")
                image_url = None
                if img_el:
                    image_url = self._pick_srcset_best(await img_el.get_attribute("srcset"))
                    if not image_url:
                        image_url = await img_el.get_attribute("src")

                image_bytes, image_mime = await self._fetch_image(page, image_url)

                products.append(
                    Product(
                        name=name,
                        price=price,
                        currency=self._currency,
                        url=url,
                        item_id=item_id,
                        image=image_bytes,
                        image_mime=image_mime,
                    )
                )
            except Exception as e:
                print(f"[{self.name}] Error extracting product {idx}: {e}")

        return products

