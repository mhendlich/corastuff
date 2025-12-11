"""Scrapers for Galaxus.ch and Galaxus.de Blackroll products."""

from datetime import datetime, UTC

from playwright.async_api import Page, async_playwright

from ..models import Product, ScrapeResult
from ..utils import parse_price
from .base import BaseScraper


class GalaxusBaseScraper(BaseScraper):
    """Base scraper for Galaxus sites (shared logic for CH and DE)."""

    base_url: str  # e.g., "https://www.galaxus.ch"

    async def scrape(self) -> ScrapeResult:
        """Run the scraper with Galaxus-specific handling."""
        async with async_playwright() as p:
            # Use Firefox - better compatibility with strict sites
            browser = await p.firefox.launch(headless=True)
            context = await browser.new_context(
                viewport={"width": 1920, "height": 1080},
                locale="de-CH",
            )
            page = await context.new_page()

            print(f"[{self.name}] Loading {self.url}...")
            try:
                await page.goto(self.url, wait_until="load", timeout=90000)
            except Exception as e:
                print(f"[{self.name}] Initial load error: {e}, continuing...")

            # Handle cookie consent banner
            await self._handle_cookie_consent(page)

            # Wait for products to load
            await page.wait_for_timeout(3000)

            products = await self.extract_products(page)
            print(f"[{self.name}] Extracted {len(products)} products")

            await browser.close()

        return ScrapeResult(
            source=self.name,
            source_url=self.url,
            scraped_at=datetime.now(UTC),
            products=products,
        )

    async def _handle_cookie_consent(self, page: Page) -> None:
        """Handle Galaxus cookie consent banner if present."""
        for selector in [
            'button:has-text("Allem zustimmen")',
            'button:has-text("Alle akzeptieren")',
            '[data-testid="accept-all-button"]',
            'button[class*="accept"]',
        ]:
            try:
                btn = await page.query_selector(selector)
                if btn and await btn.is_visible():
                    print(f"[{self.name}] Accepting cookies...")
                    await btn.click()
                    await page.wait_for_timeout(1000)
                    return
            except Exception:
                continue

    async def extract_products(self, page: Page) -> list[Product]:
        """Extract all Blackroll products from the page."""
        import re
        products: list[Product] = []

        # Wait for product articles to load
        await page.wait_for_timeout(3000)

        # Find article elements (product cards)
        product_elements = await page.query_selector_all("article")
        print(f"[{self.name}] Found {len(product_elements)} article elements")

        for idx, article in enumerate(product_elements):
            try:
                # Get product link with aria-label (contains product name)
                link = await article.query_selector('a[href*="/product/"]')
                if not link:
                    continue

                # Get name from aria-label
                name = await link.get_attribute("aria-label")
                if not name:
                    continue

                # Clean up HTML entities
                name = name.replace("\xa0", " ").strip()

                # Get URL
                url = await link.get_attribute("href")
                if url and not url.startswith("http"):
                    url = f"{self.base_url}{url}"

                # Extract item_id from URL (last number sequence)
                item_id = None
                if url:
                    if match := re.search(r"-(\d{6,})(?:\?|$|/|#)", url):
                        item_id = match.group(1)

                # Get price from price container
                price = None
                currency = None
                price_container = await article.query_selector('div[class*="yRGTUHk"]')
                if price_container:
                    price_text = await price_container.inner_text()
                    price, currency = parse_price(price_text)

                products.append(Product(
                    name=name,
                    price=price,
                    currency=currency,
                    url=url,
                    item_id=item_id,
                    image=None,
                ))

            except Exception as e:
                print(f"[{self.name}] Error extracting product {idx}: {e}")

        return products


class GalaxusCHScraper(GalaxusBaseScraper):
    """Scrape Blackroll products from Galaxus.ch (Switzerland)."""

    name = "galaxus_ch"
    url = "https://www.galaxus.ch/de/brand/blackroll-11375"
    base_url = "https://www.galaxus.ch"


class GalaxusDEScraper(GalaxusBaseScraper):
    """Scrape Blackroll products from Galaxus.de (Germany)."""

    name = "galaxus_de"
    url = "https://www.galaxus.de/de/brand/blackroll-11375"
    base_url = "https://www.galaxus.de"
