"""Background scheduler for running scrapers on a schedule."""

from __future__ import annotations

import asyncio
import logging
from datetime import datetime, timedelta, UTC
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from .db import ProductDatabase

from .scrapers import get_scraper, list_scrapers

logger = logging.getLogger(__name__)


class ScraperScheduler:
    """Manages scheduled scraper runs as a background task."""

    def __init__(self, db: ProductDatabase, check_interval: int = 60):
        """
        Initialize the scheduler.

        Args:
            db: Database instance for schedule management
            check_interval: Seconds between checks for due schedules (default: 60)
        """
        self.db = db
        self.check_interval = check_interval
        self._task: asyncio.Task | None = None
        self._running = False
        self._active_scrapers: set[str] = set()

    @property
    def is_running(self) -> bool:
        """Check if the scheduler is currently running."""
        return self._running

    def start(self):
        """Start the scheduler background task."""
        if self._running:
            logger.warning("Scheduler is already running")
            return

        self._running = True
        self._task = asyncio.create_task(self._run_loop())
        logger.info("Scheduler started")

    def stop(self):
        """Stop the scheduler background task."""
        self._running = False
        if self._task:
            self._task.cancel()
            self._task = None
        logger.info("Scheduler stopped")

    async def _run_loop(self):
        """Main scheduler loop - checks for due schedules and runs scrapers."""
        while self._running:
            try:
                await self._check_and_run_due_scrapers()
            except Exception as e:
                logger.error(f"Scheduler error: {e}")

            # Wait before next check
            await asyncio.sleep(self.check_interval)

    async def _check_and_run_due_scrapers(self):
        """Check for due schedules and run scrapers."""
        due_schedules = self.db.get_due_schedules()

        for schedule in due_schedules:
            scraper_name = schedule["scraper_name"]

            # Skip if already running
            if scraper_name in self._active_scrapers:
                logger.debug(f"Scraper {scraper_name} is already running, skipping")
                continue

            # Run the scraper
            asyncio.create_task(self._run_scraper(scraper_name, schedule))

    async def _run_scraper(self, scraper_name: str, schedule: dict):
        """Run a single scraper and update its schedule."""
        self._active_scrapers.add(scraper_name)
        logger.info(f"Scheduled run starting for: {scraper_name}")

        try:
            scraper = get_scraper(scraper_name)
            result = await scraper.scrape()
            self.db.save_results(result)
            logger.info(f"Scheduled run completed for {scraper_name}: {len(result.products)} products")
        except Exception as e:
            logger.error(f"Scheduled run failed for {scraper_name}: {e}")
        finally:
            # Update schedule with last_run and calculate next_run
            now = datetime.now(UTC)
            interval_minutes = schedule["interval_minutes"]
            next_run = now + timedelta(minutes=interval_minutes)

            self.db.update_schedule_last_run(
                scraper_name,
                now.isoformat(),
                next_run.isoformat(),
            )

            self._active_scrapers.discard(scraper_name)

    def get_status(self) -> dict:
        """Get current scheduler status."""
        schedules = self.db.get_all_schedules()
        enabled_count = sum(1 for s in schedules if s["enabled"])

        return {
            "running": self._running,
            "active_scrapers": list(self._active_scrapers),
            "total_schedules": len(schedules),
            "enabled_schedules": enabled_count,
            "check_interval": self.check_interval,
        }


# Global scheduler instance (set when app starts)
_scheduler: ScraperScheduler | None = None


def get_scheduler() -> ScraperScheduler | None:
    """Get the global scheduler instance."""
    return _scheduler


def init_scheduler(db: ProductDatabase, check_interval: int = 60) -> ScraperScheduler:
    """Initialize and return the global scheduler instance."""
    global _scheduler
    _scheduler = ScraperScheduler(db, check_interval)
    return _scheduler
