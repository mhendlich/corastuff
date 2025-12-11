"""Scraper for Kaufland.de Blackroll products."""

import random
import re
from datetime import datetime, UTC

import cloudscraper
from bs4 import BeautifulSoup
from playwright.async_api import Page, async_playwright
from playwright_stealth import Stealth

from ..models import Product, ScrapeResult
from ..utils import parse_price
from .base import BaseScraper


class KauflandScraper(BaseScraper):
    """Scrape Blackroll products from Kaufland.de.

    Uses cloudscraper to bypass Cloudflare protection, with Playwright as fallback.
    """

    name = "kaufland"
    url = "https://www.kaufland.de/s/?21=793090&search_value=blackroll"

    async def scrape(self) -> ScrapeResult:
        """Run the scraper, trying cloudscraper first then Playwright fallback."""
        # Try cloudscraper first (handles Cloudflare JS challenges)
        products = self._scrape_with_cloudscraper()
        if products:
            print(f"[{self.name}] Successfully scraped {len(products)} products with cloudscraper")
            return ScrapeResult(
                source=self.name,
                source_url=self.url,
                scraped_at=datetime.now(UTC),
                products=products,
            )

        # Fall back to Playwright if cloudscraper fails
        print(f"[{self.name}] Cloudscraper failed, trying Playwright...")
        return await self._scrape_with_playwright()

    def _scrape_with_cloudscraper(self) -> list[Product]:
        """Try to scrape using cloudscraper to bypass Cloudflare."""
        import time

        # Try different browser configurations
        browser_configs = [
            {'browser': 'chrome', 'platform': 'linux', 'desktop': True},
            {'browser': 'chrome', 'platform': 'windows', 'desktop': True},
            {'browser': 'firefox', 'platform': 'linux', 'desktop': True},
            {'browser': 'firefox', 'platform': 'windows', 'desktop': True},
        ]

        for config in browser_configs:
            try:
                scraper = cloudscraper.create_scraper(
                    browser=config,
                    delay=10,
                    interpreter='js2py',  # Use js2py interpreter for JS challenges
                )

                print(f"[{self.name}] Trying cloudscraper with {config['browser']}/{config['platform']}...")
                response = scraper.get(
                    self.url,
                    headers={
                        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
                        'Accept-Language': 'de-DE,de;q=0.9,en-US;q=0.8,en;q=0.7',
                        'Accept-Encoding': 'gzip, deflate, br',
                        'Cache-Control': 'max-age=0',
                        'Sec-Ch-Ua': '"Chromium";v="130", "Google Chrome";v="130", "Not?A_Brand";v="99"',
                        'Sec-Ch-Ua-Mobile': '?0',
                        'Sec-Ch-Ua-Platform': '"Linux"',
                        'Sec-Fetch-Dest': 'document',
                        'Sec-Fetch-Mode': 'navigate',
                        'Sec-Fetch-Site': 'none',
                        'Sec-Fetch-User': '?1',
                        'Upgrade-Insecure-Requests': '1',
                    },
                    timeout=30,
                )

                if response.status_code == 200:
                    # Check if we got blocked
                    if "Zugriff blockiert" in response.text or "Access denied" in response.text:
                        print(f"[{self.name}] Cloudscraper was blocked by Cloudflare")
                        continue

                    # Check if we got a Cloudflare challenge page
                    if "challenge-platform" in response.text or "cf-browser-verification" in response.text:
                        print(f"[{self.name}] Cloudscraper hit Cloudflare challenge page")
                        continue

                    print(f"[{self.name}] Cloudscraper got page successfully, parsing...")
                    products = self._parse_html(response.text)
                    if products:
                        return products
                    print(f"[{self.name}] No products found in HTML, trying next config...")
                else:
                    print(f"[{self.name}] Cloudscraper got status {response.status_code}")

                time.sleep(2)  # Brief delay between attempts

            except cloudscraper.exceptions.CloudflareChallengeError as e:
                print(f"[{self.name}] Cloudflare challenge failed: {e}")
            except Exception as e:
                print(f"[{self.name}] Cloudscraper error: {e}")

        return []

    def _parse_html(self, html: str) -> list[Product]:
        """Parse product data from HTML using BeautifulSoup."""
        products: list[Product] = []
        soup = BeautifulSoup(html, 'lxml')

        # Find product tiles
        product_elements = soup.select('article[data-t="product-tile"]')
        if not product_elements:
            product_elements = soup.select('[data-t="product-tile"]')
        if not product_elements:
            product_elements = soup.select('.product-tile')

        print(f"[{self.name}] Found {len(product_elements)} product elements in HTML")

        for idx, element in enumerate(product_elements):
            try:
                # Get product link
                link = element.select_one('a[href*="/product/"]')
                if not link:
                    link = element.select_one('a[href]')
                if not link:
                    continue

                # Get URL
                url = link.get('href')
                if url and not url.startswith("http"):
                    url = f"https://www.kaufland.de{url}"

                # Get product name
                name = link.get('title')
                if not name:
                    name_el = element.select_one('[data-t="product-title"]')
                    if not name_el:
                        name_el = element.select_one('.product-tile__title')
                    if not name_el:
                        name_el = element.select_one('h3')
                    if name_el:
                        name = name_el.get_text(strip=True)

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
                price_el = element.select_one('[data-t="product-price"]')
                if not price_el:
                    price_el = element.select_one('.product-tile__price')
                if not price_el:
                    price_el = element.select_one('[class*="price"]')
                if price_el:
                    price_text = price_el.get_text(strip=True)
                    price, currency = parse_price(price_text)

                products.append(Product(
                    name=name,
                    price=price,
                    currency=currency,
                    url=url,
                    item_id=item_id,
                ))

            except Exception as e:
                print(f"[{self.name}] Error parsing product {idx}: {e}")

        return products

    async def _scrape_with_playwright(self) -> ScrapeResult:
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
