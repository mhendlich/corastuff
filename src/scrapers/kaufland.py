"""Scraper for Kaufland.de Blackroll products."""

import random
from datetime import datetime, UTC

from playwright.async_api import Page, async_playwright
from playwright_stealth import Stealth

from ..models import Product, ScrapeResult
from ..utils import parse_price
from .base import BaseScraper


class KauflandScraper(BaseScraper):
    """Scrape Blackroll products from Kaufland.de.

    Note: Kaufland.de has aggressive Cloudflare protection that may block
    automated requests. If you encounter "Zugriff blockiert" (Access blocked),
    you may need to:
    - Use a residential proxy service
    - Run with headless=False and solve CAPTCHAs manually
    - Wait and retry later from a different IP
    """

    name = "kaufland"
    url = "https://www.kaufland.de/s/?21=793090&search_value=blackroll"

    async def scrape(self) -> ScrapeResult:
        """Run the scraper with Kaufland-specific handling."""
        async with async_playwright() as p:
            # Use Chromium with stealth mode for anti-bot bypass
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
            )
            page = await context.new_page()
            # Apply stealth mode to avoid bot detection
            stealth = Stealth()
            await stealth.apply_stealth_async(page)

            print(f"[{self.name}] Loading {self.url}...")
            try:
                await page.goto(self.url, wait_until="domcontentloaded", timeout=60000)
            except Exception as e:
                print(f"[{self.name}] Initial load error: {e}, continuing...")

            # Wait for potential Cloudflare challenge to resolve
            await page.wait_for_timeout(5000)

            # Check if we hit Cloudflare block or challenge
            page_content = await page.content()
            if "Zugriff blockiert" in page_content:
                print(f"[{self.name}] ERROR: Cloudflare blocked access (IP blocked)")
                print(f"[{self.name}] Try using a residential proxy or different IP")
                await browser.close()
                return ScrapeResult(
                    source=self.name,
                    source_url=self.url,
                    scraped_at=datetime.now(UTC),
                    products=[],
                )

            if await page.query_selector('text="Verifizierung erforderlich"'):
                print(f"[{self.name}] Cloudflare challenge detected, waiting...")
                cf_checkbox = await page.query_selector('input[type="checkbox"]')
                if cf_checkbox:
                    await cf_checkbox.click()
                    await page.wait_for_timeout(5000)

            # Handle cookie consent banner
            await self._handle_cookie_consent(page)

            # Wait for products to load with human-like delay
            await page.wait_for_timeout(2000 + random.randint(0, 1000))

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
        """Handle Kaufland cookie consent banner if present."""
        for selector in [
            'button#onetrust-accept-btn-handler',
            'button:has-text("Alle akzeptieren")',
            'button:has-text("Alle Cookies akzeptieren")',
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
        """Extract all Blackroll products from the search results."""
        import re
        products: list[Product] = []

        # Wait for product grid to load
        await page.wait_for_timeout(2000)

        # Kaufland uses product-tile or article elements for product cards
        product_elements = await page.query_selector_all('article[data-t="product-tile"]')
        if not product_elements:
            # Fallback selectors
            product_elements = await page.query_selector_all('[data-t="product-tile"]')
        if not product_elements:
            product_elements = await page.query_selector_all('.product-tile')

        print(f"[{self.name}] Found {len(product_elements)} product elements")

        for idx, element in enumerate(product_elements):
            try:
                # Get product link
                link = await element.query_selector('a[href*="/product/"]')
                if not link:
                    link = await element.query_selector('a[href]')
                if not link:
                    continue

                # Get URL
                url = await link.get_attribute("href")
                if url and not url.startswith("http"):
                    url = f"https://www.kaufland.de{url}"

                # Get product name from title attribute or text content
                name = await link.get_attribute("title")
                if not name:
                    name_el = await element.query_selector('[data-t="product-title"]')
                    if not name_el:
                        name_el = await element.query_selector('.product-tile__title')
                    if not name_el:
                        name_el = await element.query_selector('h3')
                    if name_el:
                        name = await name_el.inner_text()

                if not name:
                    continue

                name = name.strip()

                # Extract item_id from URL
                item_id = None
                if url:
                    if match := re.search(r'/(\d{6,})(?:\?|$|/|#|\.)', url):
                        item_id = match.group(1)

                # Get price
                price = None
                currency = None
                price_el = await element.query_selector('[data-t="product-price"]')
                if not price_el:
                    price_el = await element.query_selector('.product-tile__price')
                if not price_el:
                    price_el = await element.query_selector('[class*="price"]')
                if price_el:
                    price_text = await price_el.inner_text()
                    price, currency = parse_price(price_text)

                products.append(Product(
                    name=name,
                    price=price,
                    currency=currency,
                    url=url,
                    item_id=item_id,
                ))

            except Exception as e:
                print(f"[{self.name}] Error extracting product {idx}: {e}")

        return products
