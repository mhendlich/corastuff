"""Worker process for executing scraper jobs from the queue."""

from __future__ import annotations

import asyncio
import logging
import signal
import uuid
from time import perf_counter
from datetime import datetime, UTC
from collections import defaultdict

from .db import ProductDatabase
from .job_queue import JobQueue
from .scrapers import get_scraper
from .scrapers.browser_pool import BrowserPool
from .scrapers.amazon import scrape_amazon_listing
from .models import ScrapeResult

logger = logging.getLogger(__name__)


class Worker:
    """Worker that polls the job queue and executes scraper jobs in parallel."""

    def __init__(
        self,
        db: ProductDatabase,
        poll_interval: float = 5.0,
        stale_check_interval: float = 60.0,
        max_concurrent_jobs: int = 10,
    ):
        """
        Initialize the worker.

        Args:
            db: Database instance
            poll_interval: Seconds between queue polls when idle
            stale_check_interval: Seconds between stale job checks
            max_concurrent_jobs: Maximum number of jobs to run in parallel
        """
        self.db = db
        self.queue = JobQueue(db)
        self.poll_interval = poll_interval
        self.stale_check_interval = stale_check_interval
        self.max_concurrent_jobs = max_concurrent_jobs
        self.worker_id = f"worker-{uuid.uuid4().hex[:8]}"
        self._running = False
        self._running_jobs: dict[int, asyncio.Task] = {}

    async def start(self) -> None:
        """Start the worker loop."""
        self._running = True
        logger.info(f"Worker {self.worker_id} starting...")

        # Setup signal handlers for graceful shutdown
        loop = asyncio.get_event_loop()
        for sig in (signal.SIGTERM, signal.SIGINT):
            loop.add_signal_handler(sig, self._handle_shutdown)

        # Start stale job recovery task
        stale_task = asyncio.create_task(self._stale_job_checker())

        try:
            await self._run_loop()
        finally:
            stale_task.cancel()
            try:
                await stale_task
            except asyncio.CancelledError:
                pass
            # Cleanup browser pool on shutdown
            await BrowserPool.shutdown()
            logger.info(f"Worker {self.worker_id} stopped")

    async def _run_loop(self) -> None:
        """Main worker loop - poll queue and execute jobs in parallel."""
        while self._running:
            try:
                # Clean up completed tasks
                self._cleanup_finished_tasks()

                configured_limit = self.db.get_scraper_concurrency_limit(
                    default=self.max_concurrent_jobs
                )
                effective_limit = max(1, configured_limit)

                # Check if we can take more jobs
                if len(self._running_jobs) < effective_limit:
                    job = self.queue.claim_next(
                        self.worker_id,
                        max_running_jobs=effective_limit,
                    )

                    if job:
                        # Start job in background task
                        task = asyncio.create_task(self._execute_job(job))
                        self._running_jobs[job["id"]] = task
                        # Don't sleep - immediately try to claim another job
                        continue

                # No jobs available or at capacity, wait before polling again
                await asyncio.sleep(self.poll_interval)

            except Exception as e:
                logger.error(f"Worker loop error: {e}")
                await asyncio.sleep(self.poll_interval)

    def _cleanup_finished_tasks(self) -> None:
        """Remove completed tasks from the running jobs dict."""
        finished = [job_id for job_id, task in self._running_jobs.items() if task.done()]
        for job_id in finished:
            task = self._running_jobs.pop(job_id)
            # Log any unexpected exceptions
            if task.exception():
                logger.error(f"Job {job_id} task raised exception: {task.exception()}")

    async def _execute_job(self, job: dict) -> None:
        """Execute a single scraper job."""
        scraper_name = job["scraper_name"]
        job_id = job["id"]

        logger.info(f"Executing job {job_id}: {scraper_name}")
        start_time = perf_counter()

        try:
            scraper = get_scraper(scraper_name)
            result = await scraper.scrape()

            duration = perf_counter() - start_time
            products_found = len(result.products)

            if products_found == 0:
                error_msg = "No products found"
                self.queue.complete(
                    job_id,
                    success=False,
                    products_found=0,
                    error_message=error_msg,
                    duration_seconds=duration,
                )
                logger.warning(f"Job {job_id} failed: {error_msg}")
                return

            # Save results to database
            self.db.save_results(result)

            # Auto-link Amazon storefront products to canonicals (high confidence only).
            if scraper_name.startswith("amazon"):
                try:
                    actions = self.db.auto_link_source_products(result.source, min_score=0.8)
                    if actions:
                        logger.info(
                            f"Auto-linked {len(actions)} {result.source} products to canonicals"
                        )
                except Exception as link_err:
                    logger.warning(f"Amazon auto-linking failed: {link_err}")

                # Also refresh any tracked ASINs that are not currently visible in the storefront scrape.
                try:
                    scraped_asins = {p.item_id for p in result.products if p.item_id}
                    tracked_links = self.db.get_tracked_amazon_links()

                    asins_by_source: dict[str, set[str]] = defaultdict(set)
                    sources_by_asin: dict[str, set[str]] = defaultdict(set)
                    for link in tracked_links:
                        asin = link.get("asin")
                        src = link.get("source")
                        if not asin or not src:
                            continue
                        asins_by_source[src].add(asin)
                        sources_by_asin[asin].add(src)

                    to_refresh_asins: set[str] = set()
                    # Legacy manual links stored under "amazon" need per-ASIN refresh every run.
                    to_refresh_asins |= asins_by_source.get("amazon", set())
                    # Refresh tracked ASINs for the storefront source that weren't found in the listing scrape.
                    to_refresh_asins |= asins_by_source.get(result.source, set()) - scraped_asins

                    missing_asins = sorted(to_refresh_asins)

                    if missing_asins:
                        logger.info(
                            f"Refreshing {len(missing_asins)} tracked Amazon ASINs not found in storefront"
                        )

                    for asin in missing_asins[:50]:
                        prod = await scrape_amazon_listing(asin=asin)
                        if not prod:
                            continue
                        for src in sources_by_asin.get(asin, {result.source}):
                            # Avoid redundant save for storefront source if already updated there.
                            if src == result.source and asin in scraped_asins and src != "amazon":
                                continue
                            self.db.save_results(
                                ScrapeResult(
                                    source=src,
                                    source_url=prod.url or f"https://www.amazon.de/dp/{asin}",
                                    scraped_at=datetime.now(UTC),
                                    products=[
                                        prod.__class__(
                                            name=prod.name,
                                            price=prod.price,
                                            currency=prod.currency,
                                            url=prod.url,
                                            item_id=prod.item_id,
                                            image=prod.image,
                                            image_mime=prod.image_mime,
                                        )
                                    ],
                                )
                            )
                except Exception as refresh_err:
                    logger.warning(f"Amazon tracked-ASIN refresh failed: {refresh_err}")

            self.queue.complete(
                job_id,
                success=True,
                products_found=products_found,
                duration_seconds=duration,
            )

            logger.info(f"Job {job_id} completed: {products_found} products in {duration:.2f}s")

        except Exception as e:
            duration = perf_counter() - start_time
            error_msg = str(e)

            self.queue.complete(
                job_id,
                success=False,
                error_message=error_msg,
                duration_seconds=duration,
            )

            logger.error(f"Job {job_id} failed: {error_msg}")

    async def _stale_job_checker(self) -> None:
        """Periodically check for and reclaim stale jobs."""
        while self._running:
            await asyncio.sleep(self.stale_check_interval)
            try:
                reclaimed = self.queue.reclaim_stale_jobs()
                if reclaimed > 0:
                    logger.warning(f"Reclaimed {reclaimed} stale jobs")
            except Exception as e:
                logger.error(f"Stale job check error: {e}")

    def _handle_shutdown(self) -> None:
        """Handle shutdown signals gracefully."""
        logger.info(f"Worker {self.worker_id} received shutdown signal")
        self._running = False

        # Note: running jobs will be reclaimed by stale job checker if interrupted
        if self._running_jobs:
            logger.warning(f"Interrupted {len(self._running_jobs)} running jobs - will be reclaimed")

    def get_status(self) -> dict:
        """Get current worker status."""
        configured_limit = self.db.get_scraper_concurrency_limit(
            default=self.max_concurrent_jobs
        )
        return {
            "worker_id": self.worker_id,
            "running": self._running,
            "running_jobs": list(self._running_jobs.keys()),
            "running_job_count": len(self._running_jobs),
            "max_concurrent_jobs": max(1, configured_limit),
            "queue_status": self.queue.get_queue_status(),
        }


async def run_worker(poll_interval: float = 5.0) -> None:
    """
    Run the worker (entry point for CLI).

    Args:
        poll_interval: Seconds between queue polls when idle
    """
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s - %(name)s - %(levelname)s - %(message)s",
    )

    db = ProductDatabase()
    worker = Worker(db, poll_interval=poll_interval)
    await worker.start()
