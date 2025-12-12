import unittest

from src.scrapers.otto import OttoScraper


class TestOttoLive(unittest.IsolatedAsyncioTestCase):
    async def test_otto_live_page_scrape_returns_products(self) -> None:
        scraper = OttoScraper()
        result = await scraper.scrape()
        self.assertGreater(len(result.products), 0, "expected at least one product from live OTTO page")

        first = result.products[0]
        self.assertTrue(first.name)
        self.assertTrue(first.url and first.url.startswith("https://www.otto.de/"))
        self.assertTrue(
            any(p.image for p in result.products),
            "expected at least one product image to be fetched",
        )
