"""Scraper for Bergzeit.de Blackroll products."""

from playwright.async_api import Page

from ..models import Product
from ..utils import parse_price
from .base import BaseScraper


class BergzeitScraper(BaseScraper):
    """Scrape Blackroll products from Bergzeit.de."""

    name = "bergzeit"
    url = "https://www.bergzeit.de/marken/blackroll/"

    async def extract_products(self, page: Page) -> list[Product]:
        """Extract all Blackroll products from the page."""
        products: list[Product] = []

        await page.wait_for_selector(".product-box", timeout=10000)
        await page.wait_for_timeout(2000)

        if count_el := await page.query_selector(".products-list-page-header__headline-counter"):
            total_text = await count_el.inner_text()
            print(f"[{self.name}] Total products on page: {total_text}")

        product_elements = await page.query_selector_all(".product-box")
        print(f"[{self.name}] Found {len(product_elements)} product elements")

        for idx, product in enumerate(product_elements):
            try:
                name_el = await product.query_selector(".product-box-content__name")
                name = (await name_el.inner_text()).strip() if name_el else None

                price_el = await product.query_selector(".product-box-content__price")
                price_text = (await price_el.inner_text()).strip() if price_el else None
                price, currency = parse_price(price_text)

                url = await product.get_attribute("href")
                if url and not url.startswith("http"):
                    url = f"https://www.bergzeit.de{url}"

                item_id = await product.get_attribute("data-item-id")

                if name:
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
