"""Scraper for Sportscheck.com Blackroll products."""

from datetime import datetime, UTC

from playwright.async_api import Page, async_playwright

from ..models import Product, ScrapeResult
from ..utils import parse_price
from .base import BaseScraper


class SportscheckScraper(BaseScraper):
    """Scrape Blackroll products from Sportscheck.com."""

    name = "sportscheck"
    display_name = "Sportscheck"
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

                # Try to capture the product image from the tile
                image_bytes = None
                image_mime = None
                image_url = None

                try:
                    await product.scroll_into_view_if_needed()
                    await page.wait_for_timeout(100)
                except Exception:
                    pass

                img_el = await product.query_selector("img")
                for _ in range(4):
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
                    source_el = await product.query_selector("source[srcset]")
                    if source_el:
                        image_url = await source_el.get_attribute("srcset")
                        if image_url and "," in image_url:
                            image_url = image_url.split(",")[0].split()[0]

                if image_url:
                    if image_url.startswith("//"):
                        image_url = f"https:{image_url}"
                    elif image_url.startswith("/"):
                        image_url = f"https://www.sportscheck.com{image_url}"

                    try:
                        response = await page.context.request.get(image_url)
                        if response.ok:
                            image_bytes = await response.body()
                            image_mime = response.headers.get("content-type")
                            if image_mime and ";" in image_mime:
                                image_mime = image_mime.split(";", 1)[0].strip()
                    except Exception as img_err:
                        print(f"[{self.name}] Failed to fetch image for {full_name}: {img_err}")

                if full_name:
                    products.append(Product(
                        name=full_name,
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
