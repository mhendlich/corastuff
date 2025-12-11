"""Scraper for Sportscheck.com Blackroll products."""

from datetime import datetime, UTC

from playwright.async_api import Page, async_playwright

from ..models import Product, ScrapeResult
from ..utils import parse_price
from .base import BaseScraper


class SportscheckScraper(BaseScraper):
    """Scrape Blackroll products from Sportscheck.com."""

    name = "sportscheck"
    url = "https://www.sportscheck.com/blackroll/"

    async def scrape(self) -> ScrapeResult:
        """Run the scraper with custom handling for Sportscheck."""
        async with async_playwright() as p:
            browser = await p.chromium.launch(headless=True)
            page = await browser.new_page()

            print(f"[{self.name}] Loading {self.url}...")
            await page.goto(self.url, wait_until="domcontentloaded", timeout=60000)

            # Handle cookie consent banner if present
            for selector in [
                '[data-testid="uc-accept-all-button"]',
                'button:has-text("Alle akzeptieren")',
                "#onetrust-accept-btn-handler",
            ]:
                if cookie_btn := await page.query_selector(selector):
                    print(f"[{self.name}] Accepting cookies...")
                    await cookie_btn.click()
                    await page.wait_for_timeout(1000)
                    break

            products = await self.extract_products(page)
            print(f"[{self.name}] Extracted {len(products)} products")

            await browser.close()

        return ScrapeResult(
            source=self.name,
            source_url=self.url,
            scraped_at=datetime.now(UTC),
            products=products,
        )

    async def extract_products(self, page: Page) -> list[Product]:
        """Extract all Blackroll products from the page."""
        products: list[Product] = []

        await page.wait_for_selector(".c-product-tile.pues-product", timeout=15000)
        await page.wait_for_timeout(2000)

        product_elements = await page.query_selector_all(
            ".c-product-tile.pues-product:not(.c-product-tile-placeholder)"
        )
        print(f"[{self.name}] Found {len(product_elements)} product elements")

        for idx, product in enumerate(product_elements):
            try:
                name_el = await product.query_selector(".c-product-tile-information__name")
                name = (await name_el.inner_text()).strip() if name_el else None

                brand_el = await product.query_selector(".c-product-tile-information__brand")
                brand = (await brand_el.inner_text()).strip() if brand_el else None

                category_el = await product.query_selector(".c-product-tile-information__category")
                category = (await category_el.inner_text()).strip() if category_el else None

                # Build full name
                full_name = f"{brand} {name}" if brand and name else name
                if full_name and category:
                    full_name = f"{full_name} - {category}"

                price_el = await product.query_selector(".c-product-tile-information__price")
                price_text = (await price_el.inner_text()).strip() if price_el else None
                price, currency = parse_price(price_text)

                link_el = await product.query_selector("a.c-product-tile-information__captions")
                if not link_el:
                    link_el = await product.query_selector("a[href]")

                url = await link_el.get_attribute("href") if link_el else None
                if url and not url.startswith("http"):
                    url = f"https://www.sportscheck.com{url}"

                item_id = await product.get_attribute("data-product-sku")

                if full_name:
                    products.append(Product(
                        name=full_name,
                        price=price,
                        currency=currency,
                        url=url,
                        item_id=item_id,
                        image=None,
                    ))

            except Exception as e:
                print(f"[{self.name}] Error extracting product {idx}: {e}")

        return products
