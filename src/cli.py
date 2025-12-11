#!/usr/bin/env python3
"""CLI entry point for the multi-source scraper."""

import asyncio
import argparse
import sys
import time

from .db import ProductDatabase
from .models import ScrapeResult
from .scrapers import get_scraper, get_all_scrapers, list_scrapers, BaseScraper


def print_result(result: ScrapeResult) -> None:
    """Print scrape result summary."""
    print(f"\n[{result.source}] Extracted {len(result.products)} products:")
    for i, p in enumerate(result.products[:5], 1):
        print(f"  {i}. {p.name} - {p.price}")
    if len(result.products) > 5:
        print(f"  ... and {len(result.products) - 5} more")


async def run_scraper(scraper: BaseScraper) -> ScrapeResult | None:
    """Run a single scraper and return results."""
    print(f"\n{'=' * 60}")
    print(f"Running scraper: {scraper.name}")
    print(f"{'=' * 60}")

    result = await scraper.scrape()

    if result.products:
        print_result(result)
        scraper.save_results(result)
    else:
        print(f"[{scraper.name}] No products found!")

    return result


async def run_all_parallel(scrapers: list[BaseScraper], db: ProductDatabase) -> None:
    """Run all scrapers in parallel using TaskGroup."""
    print(f"Running {len(scrapers)} scraper(s) in parallel...")
    start = time.perf_counter()

    async with asyncio.TaskGroup() as tg:
        tasks = [tg.create_task(run_scraper(s)) for s in scrapers]

    # Save results to database
    for task in tasks:
        if (result := task.result()) and result.products:
            db.save_results(result)

    elapsed = time.perf_counter() - start
    print(f"\nAll scrapers completed in {elapsed:.2f}s")


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Multi-source product scraper",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
  python -m src.cli --source bergzeit    # Run single source
  python -m src.cli --all                # Run all sources in parallel
  python -m src.cli --list               # List available sources
        """,
    )

    group = parser.add_mutually_exclusive_group(required=True)
    group.add_argument("--source", "-s", help="Run a specific source scraper")
    group.add_argument("--all", "-a", action="store_true", help="Run all scrapers in parallel")
    group.add_argument("--list", "-l", action="store_true", help="List available scrapers")

    args = parser.parse_args()

    if args.list:
        print("Available scrapers:")
        for name in list_scrapers():
            print(f"  - {name}")
        return 0

    db = ProductDatabase()

    if args.all:
        asyncio.run(run_all_parallel(get_all_scrapers(), db))
    else:
        try:
            scraper = get_scraper(args.source)

            async def run_single():
                if result := await run_scraper(scraper):
                    db.save_results(result)

            asyncio.run(run_single())
        except ValueError as e:
            print(f"Error: {e}", file=sys.stderr)
            return 1

    print("\n" + "=" * 60)
    print("Done!")
    print("=" * 60)
    return 0


if __name__ == "__main__":
    sys.exit(main())
