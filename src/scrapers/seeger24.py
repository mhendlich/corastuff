"""Scraper for seeger24.de Faszien training products."""

from __future__ import annotations

from datetime import datetime, UTC
from urllib.parse import urljoin, urlparse

from playwright.async_api import Page

from ..models import Product, ScrapeResult
from ..utils import parse_price
from .base import BaseScraper
from .browser_pool import get_browser_context


class Seeger24Scraper(BaseScraper):
    """Scrape products from Seeger24 category pages."""

    name = "seeger24"
    display_name = "Seeger24"
    url = "https://www.seeger24.de/Sport-und-Wellness/Faszientraining"

    async def scrape(self) -> ScrapeResult:
        async with get_browser_context() as context:
            page = await context.new_page()

            print(f"[{self.name}] Loading {self.url}...")
            await page.goto(self.url, wait_until="domcontentloaded", timeout=90000)

            await self._handle_cookie_consent(page)
            await page.wait_for_selector(".collection-products", timeout=60000, state="attached")
            await page.wait_for_timeout(800)

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
        return path.split("/")[-1] or None

    @staticmethod
    def _pick_image_url(src: str | None, srcset: str | None) -> str | None:
        if srcset:
            first = srcset.split(",")[0].strip()
            if first:
                return first.split()[0].strip() or None
        return (src or "").strip() or None

    async def _fetch_image(self, page: Page, image_url: str | None) -> tuple[bytes | None, str | None]:
        if not image_url:
            return None, None
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
        except Exception:
            return None, None

    async def extract_products(self, page: Page) -> list[Product]:
        products: list[Product] = []

        await page.wait_for_selector(".collection-products > div", timeout=60000, state="attached")
        cards = await page.query_selector_all(".collection-products > div")
        print(f"[{self.name}] Found {len(cards)} product cards")

        for idx, card in enumerate(cards):
            try:
                try:
                    await card.scroll_into_view_if_needed()
                    await page.wait_for_timeout(120)
                except Exception:
                    pass

                link_el = (
                    await card.query_selector("a[href]:has(div.line-clamp-2)")
                    or await card.query_selector("a[href]:has(img[data-nimg])")
                    or await card.query_selector('a[href]:has(img)')
                    or await card.query_selector("a[href]")
                )
                href = await link_el.get_attribute("href") if link_el else None
                url = urljoin("https://www.seeger24.de", href) if href else None

                name = None
                if name_el := await card.query_selector("div.line-clamp-2"):
                    name = (await name_el.inner_text() or "").strip() or None

                img_el = (
                    await card.query_selector('img[data-nimg][alt]:not([alt=""])')
                    or await card.query_selector("img[data-nimg]")
                    or await card.query_selector("img")
                )
                if not name and img_el:
                    name = (await img_el.get_attribute("alt") or "").strip() or None

                price_text = None
                if price_el := await card.query_selector('span.text-lg:has-text("€")'):
                    price_text = (await price_el.inner_text()).strip()
                elif price_el := await card.query_selector('span:has-text("€")'):
                    price_text = (await price_el.inner_text()).strip()
                price, currency = parse_price(price_text)

                image_bytes = None
                image_mime = None
                image_url = None
                if img_el:
                    src = await img_el.get_attribute("src")
                    srcset = await img_el.get_attribute("srcset") or await img_el.get_attribute("srcSet")
                    image_url = self._pick_image_url(src, srcset)
                    if image_url:
                        image_url = urljoin("https://www.seeger24.de", image_url)
                        image_bytes, image_mime = await self._fetch_image(page, image_url)

                if name and url:
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
