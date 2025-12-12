"""Scraper for Decathlon.ch Blackroll brand page."""

from __future__ import annotations

import asyncio
import re
from datetime import UTC, datetime
from urllib.parse import urljoin

from playwright.async_api import Page

from ..models import Product, ScrapeResult
from ..utils import parse_price
from .base import BaseScraper
from .browser_pool import get_browser_context

_DESKTOP_UA = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"
)

_STEALTH_INIT_SCRIPT = """
Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
Object.defineProperty(navigator, 'languages', { get: () => ['de-CH', 'de', 'en'] });
Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] });
""".strip()


class DecathlonCHScraper(BaseScraper):
    name = "decathlon_ch"
    display_name = "Decathlon.ch (Blackroll)"
    url = "https://www.decathlon.ch/de/brands/blackroll"

    user_agent = _DESKTOP_UA
    locale = "de-CH"
    viewport = {"width": 1920, "height": 1080}
    init_scripts = [_STEALTH_INIT_SCRIPT]

    _base_url = "https://www.decathlon.ch"
    _default_currency = "CHF"

    async def scrape(self) -> ScrapeResult:
        async with get_browser_context(
            browser_type=self.browser_type,
            user_agent=self.user_agent,
            locale=self.locale,
            viewport=self.viewport,
            init_scripts=self.init_scripts,
        ) as context:
            page = await context.new_page()
            print(f"[{self.name}] Loading {self.url}...")
            await page.goto(self.url, wait_until="domcontentloaded", timeout=90000)
            await self._handle_cookie_consent(page)
            await self._wait_for_products(page)
            products = await self.extract_products(page)

        deduped: dict[str, Product] = {}
        for product in products:
            key = product.item_id or product.url or product.name
            if not key:
                continue
            deduped[key] = product

        final_products = list(deduped.values())
        print(f"[{self.name}] Extracted {len(final_products)} products")

        return ScrapeResult(
            source=self.name,
            source_url=self.url,
            scraped_at=datetime.now(UTC),
            products=final_products,
        )

    async def _handle_cookie_consent(self, page: Page) -> None:
        for selector in [
            "#didomi-notice-agree-button",
            'button:has-text("Annehmen und Schliessen")',
            'button:has-text("Accept all")',
            'button:has-text("Accept")',
            'button:has-text("Alle akzeptieren")',
            'button:has-text("Allem zustimmen")',
            "#onetrust-accept-btn-handler",
            '[data-testid="uc-accept-all-button"]',
        ]:
            try:
                btn = await page.query_selector(selector)
                if btn and await btn.is_visible():
                    await btn.click()
                    await page.wait_for_timeout(600)
                    return
            except Exception:
                continue

    async def _wait_for_products(self, page: Page) -> None:
        await page.wait_for_selector('article:has(a[href*="/p/"])', timeout=60000, state="attached")
        await page.wait_for_timeout(1200)

    @staticmethod
    def _pick_srcset_url(srcset: str | None) -> str | None:
        if not srcset or not isinstance(srcset, str):
            return None
        candidates: list[tuple[int, str]] = []
        for part in [p.strip() for p in srcset.split(",") if p.strip()]:
            chunks = part.split()
            if not chunks:
                continue
            url = chunks[0].strip()
            if not url:
                continue
            score = 0
            if len(chunks) >= 2:
                hint = chunks[1].strip().lower()
                if hint.endswith("w"):
                    try:
                        score = int(re.sub(r"[^0-9]", "", hint) or "0")
                    except Exception:
                        score = 0
                elif hint.endswith("x"):
                    try:
                        score = int(float(hint[:-1]) * 1000)
                    except Exception:
                        score = 0
            candidates.append((score, url))
        if not candidates:
            return None
        candidates.sort(key=lambda t: t[0])
        return candidates[-1][1]

    @staticmethod
    def _extract_item_id(product_url: str | None) -> str | None:
        if not product_url:
            return None
        if match := re.search(r"/R-p-([0-9a-fA-F-]{8,})", product_url):
            return match.group(1)
        if match := re.search(r"[?&]mc=([^&#]+)", product_url):
            return match.group(1)
        return None

    def _normalize_url(self, value: str | None) -> str | None:
        if not value or not isinstance(value, str):
            return None
        url = value.strip()
        if not url:
            return None
        if url.startswith("//"):
            return "https:" + url
        if url.startswith("/"):
            return urljoin(self._base_url, url)
        return url

    async def _fetch_image(
        self, page: Page, image_url: str | None, *, referer: str
    ) -> tuple[bytes | None, str | None]:
        image_url = self._normalize_url(image_url)
        if not image_url:
            return None, None

        try:
            resp = await page.context.request.get(
                image_url,
                headers={
                    # Avoid requesting AVIF; Pillow cannot reliably decode it here.
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

    async def extract_products(self, page: Page) -> list[Product]:
        items = await page.eval_on_selector_all(
            'article:has(a[href*="/p/"])',
            """
            els => els.map(el => {
              const a = el.querySelector('a[href*="/p/"]');
              const img = el.querySelector('img');
              const priceEl = el.querySelector('.vp-price [data-part="amount"], [data-part="amount"]');
              const url = a ? a.href : null;
              const nameFromImg = img && img.alt ? img.alt.trim() : null;
              const nameFromLink = a && a.textContent ? a.textContent.trim() : null;
              const srcset = img ? (img.getAttribute('srcset') || img.getAttribute('data-srcset')) : null;
              const imgUrl = img ? (img.currentSrc || img.src || img.getAttribute('data-src')) : null;
              const priceText = priceEl ? priceEl.textContent.trim() : null;
              return { url, name: nameFromImg || nameFromLink, priceText, imgUrl, srcset };\n            })
            """,
        )
        if not isinstance(items, list) or not items:
            return []

        parsed: list[dict] = []
        for raw in items:
            if not isinstance(raw, dict):
                continue
            product_url = raw.get("url")
            name = (raw.get("name") or "").strip() if isinstance(raw.get("name"), str) else ""
            if not product_url or not isinstance(product_url, str) or not name:
                continue
            clean_url = product_url.split("?", 1)[0].strip()
            if not clean_url:
                continue

            image_url = None
            srcset = raw.get("srcset") if isinstance(raw.get("srcset"), str) else None
            if srcset:
                image_url = self._pick_srcset_url(srcset)
            if not image_url:
                image_url = raw.get("imgUrl") if isinstance(raw.get("imgUrl"), str) else None

            price_text = raw.get("priceText") if isinstance(raw.get("priceText"), str) else None
            amount, currency = parse_price(price_text)
            parsed.append(
                {
                    "name": name,
                    "url": clean_url,
                    "item_id": self._extract_item_id(product_url) or clean_url,
                    "price": amount,
                    "currency": currency or self._default_currency,
                    "image_url": image_url,
                }
            )

        semaphore = asyncio.Semaphore(6)

        async def build_product(entry: dict) -> Product | None:
            async with semaphore:
                image_bytes, image_mime = await self._fetch_image(
                    page, entry.get("image_url"), referer=entry["url"]
                )
            return Product(
                name=entry["name"],
                price=entry.get("price"),
                currency=entry.get("currency"),
                url=entry.get("url"),
                item_id=entry.get("item_id"),
                image=image_bytes,
                image_mime=image_mime,
            )

        products = await asyncio.gather(*(build_product(e) for e in parsed))
        return [p for p in products if p is not None]

