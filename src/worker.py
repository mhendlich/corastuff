"""Worker process for executing scraper jobs from the queue."""

from __future__ import annotations

import asyncio
import logging
import signal
import uuid
from time import perf_counter

from .db import ProductDatabase
from .job_queue import JobQueue
from .scrapers import get_scraper
from .scrapers.browser_pool import BrowserPool

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

                # Check if we can take more jobs
                if len(self._running_jobs) < self.max_concurrent_jobs:
                    job = self.queue.claim_next(self.worker_id)

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

            # Save results to database
            self.db.save_results(result)

            duration = perf_counter() - start_time
            self.queue.complete(
                job_id,
                success=True,
                products_found=len(result.products),
                duration_seconds=duration,
            )

            logger.info(f"Job {job_id} completed: {len(result.products)} products in {duration:.2f}s")

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
        return {
            "worker_id": self.worker_id,
            "running": self._running,
            "running_jobs": list(self._running_jobs.keys()),
            "running_job_count": len(self._running_jobs),
            "max_concurrent_jobs": self.max_concurrent_jobs,
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
