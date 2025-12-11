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
        await page.wait_for_selector(".product-box__image-container img", timeout=10000)

        if count_el := await page.query_selector(".products-list-page-header__headline-counter"):
            total_text = await count_el.inner_text()
            print(f"[{self.name}] Total products on page: {total_text}")

        product_elements = await page.query_selector_all(".product-box")
        print(f"[{self.name}] Found {len(product_elements)} product elements")

        for idx, product in enumerate(product_elements):
            try:
                await product.scroll_into_view_if_needed()
                await page.wait_for_timeout(150)

                name_el = await product.query_selector(".product-box-content__name")
                name = (await name_el.inner_text()).strip() if name_el else None

                price_el = await product.query_selector(".product-box-content__price")
                price_text = (await price_el.inner_text()).strip() if price_el else None
                price, currency = parse_price(price_text)

                image_bytes = None
                image_mime = None
                image_url = None
                img_el = None
                for _ in range(4):
                    if not img_el:
                        img_el = await product.query_selector(".product-box__image-container img")
                    if img_el:
                        image_url = (
                            await img_el.get_attribute("src")
                            or await img_el.get_attribute("data-src")
                            or await img_el.get_attribute("data-srcset")
                            or await img_el.get_attribute("srcset")
                        )
                        if image_url:
                            # srcset values include size hints; take the first URL
                            image_url = image_url.split(",")[0].split()[0]
                            break
                    await page.wait_for_timeout(200)

                if image_url:
                    if image_url.startswith("//"):
                        image_url = f"https:{image_url}"
                    elif image_url.startswith("/"):
                        image_url = f"https://www.bergzeit.de{image_url}"

                    try:
                        response = await page.context.request.get(image_url)
                        if response.ok:
                            image_bytes = await response.body()
                            image_mime = response.headers.get("content-type")
                            if image_mime and ";" in image_mime:
                                image_mime = image_mime.split(";", 1)[0].strip()
                    except Exception as img_err:
                        print(f"[{self.name}] Failed to fetch image for {name}: {img_err}")

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
                        image=image_bytes,
                        image_mime=image_mime,
                    ))

            except Exception as e:
                print(f"[{self.name}] Error extracting product {idx}: {e}")

        return products
