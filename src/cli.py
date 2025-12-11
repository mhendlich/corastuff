#!/usr/bin/env python3
"""CLI entry point for the multi-source scraper."""

import asyncio
import argparse
import subprocess
import sys
import time
from pathlib import Path

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


def run_serve() -> int:
    """Run both webserver and worker with auto-restart on crash."""
    import signal
    import threading

    processes: dict[str, subprocess.Popen] = {}
    shutdown_event = threading.Event()

    def start_webserver() -> subprocess.Popen:
        """Start the uvicorn webserver."""
        return subprocess.Popen(
            [
                sys.executable, "-m", "uvicorn",
                "src.webapp.app:app",
                "--host", "0.0.0.0",
                "--port", "8011",
                "--reload",
            ],
            cwd=Path(__file__).parent.parent,
        )

    def start_worker() -> subprocess.Popen:
        """Start the background worker."""
        return subprocess.Popen(
            [sys.executable, "-m", "src.cli", "--worker"],
            cwd=Path(__file__).parent.parent,
        )

    def monitor_process(name: str, starter: callable) -> None:
        """Monitor a process and restart it on crash."""
        while not shutdown_event.is_set():
            proc = processes.get(name)
            if proc is None or proc.poll() is not None:
                if proc is not None:
                    print(f"[{name}] Process exited with code {proc.returncode}, restarting in 2s...")
                    time.sleep(2)  # Brief delay before restart to release resources
                else:
                    print(f"[{name}] Starting...")
                processes[name] = starter()
            time.sleep(1)

    def shutdown(signum, frame):
        """Handle shutdown signals."""
        print("\nShutting down...")
        shutdown_event.set()
        for name, proc in processes.items():
            if proc and proc.poll() is None:
                print(f"[{name}] Terminating...")
                proc.terminate()
                try:
                    proc.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    proc.kill()

    signal.signal(signal.SIGINT, shutdown)
    signal.signal(signal.SIGTERM, shutdown)

    print("=" * 60)
    print("Starting webserver (port 8011) and worker")
    print("Press Ctrl+C to stop")
    print("=" * 60)

    # Start monitor threads
    web_thread = threading.Thread(
        target=monitor_process, args=("webserver", start_webserver), daemon=True
    )
    worker_thread = threading.Thread(
        target=monitor_process, args=("worker", start_worker), daemon=True
    )

    web_thread.start()
    worker_thread.start()

    # Wait for shutdown
    try:
        while not shutdown_event.is_set():
            time.sleep(0.5)
    except KeyboardInterrupt:
        shutdown(None, None)

    return 0


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Multi-source product scraper",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
  python -m src.cli --source bergzeit    # Run single source
  python -m src.cli --all                # Run all sources in parallel
  python -m src.cli --list               # List available sources
  python -m src.cli --worker             # Run the job queue worker
  python -m src.cli --enqueue bergzeit   # Enqueue a scraper job
  python -m src.cli --serve              # Run webserver + worker (dev mode)
        """,
    )

    group = parser.add_mutually_exclusive_group(required=True)
    group.add_argument("--source", "-s", help="Run a specific source scraper")
    group.add_argument("--all", "-a", action="store_true", help="Run all scrapers in parallel")
    group.add_argument("--list", "-l", action="store_true", help="List available scrapers")
    group.add_argument("--worker", "-w", action="store_true", help="Run the job queue worker")
    group.add_argument("--enqueue", "-e", help="Enqueue a scraper job")
    group.add_argument("--serve", action="store_true", help="Run webserver and worker together (restarts on crash)")

    args = parser.parse_args()

    if args.list:
        print("Available scrapers:")
        for name in list_scrapers():
            print(f"  - {name}")
        return 0

    if args.serve:
        return run_serve()

    if args.worker:
        from .worker import run_worker
        print("Starting job queue worker...")
        print("Press Ctrl+C to stop")
        asyncio.run(run_worker())
        return 0

    db = ProductDatabase()

    if args.enqueue:
        from .job_queue import JobQueue
        scraper_name = args.enqueue
        if scraper_name not in list_scrapers():
            print(f"Error: Unknown scraper '{scraper_name}'", file=sys.stderr)
            print(f"Available: {', '.join(list_scrapers())}", file=sys.stderr)
            return 1
        queue = JobQueue(db)
        if queue.is_scraper_queued_or_running(scraper_name):
            print(f"Scraper '{scraper_name}' is already queued or running")
            return 1
        job_id = queue.enqueue(scraper_name, source="cli")
        print(f"Job enqueued: {scraper_name} (job_id={job_id})")
        return 0

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
