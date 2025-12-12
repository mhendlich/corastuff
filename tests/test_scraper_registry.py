import unittest


class TestScraperRegistry(unittest.TestCase):
    def test_list_scrapers_includes_package_scrapers(self):
        from src.scrapers import list_scrapers

        names = set(list_scrapers())
        for expected in {
            "artzt",
            "fitshop",
            "globetrotter",
            "intersport",
            "keller_sports",
            "kuebler_sport",
            "otto",
            "sanicare",
            "seeger24",
            "sport2000",
        }:
            self.assertIn(expected, names)

    def test_get_scraper_returns_named_instance(self):
        from src.scrapers import get_scraper

        scraper = get_scraper("otto")
        self.assertEqual(scraper.name, "otto")

