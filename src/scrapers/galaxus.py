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

                # Try to fetch the product image
                image_bytes = None
                image_mime = None
                image_url = None

                try:
                    await article.scroll_into_view_if_needed()
                    await page.wait_for_timeout(100)
                except Exception:
                    pass

                img_el = None
                for _ in range(4):
                    if not img_el:
                        img_el = await article.query_selector("picture img") or await article.query_selector("img")
                    if img_el:
                        image_url = (
                            await img_el.get_attribute("src")
                            or await img_el.get_attribute("data-src")
                            or await img_el.get_attribute("data-srcset")
                            or await img_el.get_attribute("srcset")
                        )
                        if image_url:
                            if "," in image_url:
                                image_url = image_url.split(",")[0].split()[0]
                            break
                    await page.wait_for_timeout(150)

                if not image_url:
                    source_el = await article.query_selector("picture source[srcset]")
                    if source_el:
                        image_url = await source_el.get_attribute("srcset")
                        if image_url and "," in image_url:
                            image_url = image_url.split(",")[0].split()[0]

                if image_url:
                    if image_url.startswith("//"):
                        image_url = f"https:{image_url}"
                    elif image_url.startswith("/"):
                        image_url = f"{self.base_url}{image_url}"

                    try:
                        response = await page.context.request.get(image_url)
                        if response.ok:
                            image_bytes = await response.body()
                            image_mime = response.headers.get("content-type")
                            if image_mime and ";" in image_mime:
                                image_mime = image_mime.split(";", 1)[0].strip()
                    except Exception as img_err:
                        print(f"[{self.name}] Failed to fetch image for {name}: {img_err}")

                products.append(Product(
                    name=name,
                    price=price,
                    currency=currency,
                    url=url,
                    item_id=item_id,
                    image=image_bytes,
                    image_mime=image_mime,
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
