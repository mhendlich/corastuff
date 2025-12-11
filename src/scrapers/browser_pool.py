"""Browser pool for efficient Playwright browser reuse."""

from __future__ import annotations

import asyncio
from contextlib import asynccontextmanager
from typing import AsyncIterator

from playwright.async_api import async_playwright, Browser, BrowserContext, Playwright


class BrowserPool:
    """
    Singleton browser pool that reuses a shared Chromium browser.

    Creating browser contexts is much faster than launching new browsers.
    Typical browser launch: 3-5 seconds
    Context creation: ~50-100ms
    """

    _instance: BrowserPool | None = None
    _lock = asyncio.Lock()

    def __init__(self):
        self._playwright: Playwright | None = None
        self._browser: Browser | None = None
        self._active_contexts: int = 0

    @classmethod
    async def get_instance(cls) -> BrowserPool:
        """Get or create the singleton browser pool instance."""
        if cls._instance is None:
            async with cls._lock:
                if cls._instance is None:
                    cls._instance = cls()
        return cls._instance

    async def _ensure_browser(self) -> Browser:
        """Ensure browser is started, launching if necessary."""
        if self._browser is None or not self._browser.is_connected():
            if self._playwright is None:
                self._playwright = await async_playwright().start()
            self._browser = await self._playwright.chromium.launch(headless=True)
        return self._browser

    @asynccontextmanager
    async def get_context(self) -> AsyncIterator[BrowserContext]:
        """
        Get a fresh browser context from the pool.

        Contexts are isolated (separate cookies, storage) but share the browser process.
        """
        browser = await self._ensure_browser()
        context = await browser.new_context()
        self._active_contexts += 1
        try:
            yield context
        finally:
            self._active_contexts -= 1
            await context.close()

    async def close(self) -> None:
        """Close the browser and cleanup resources."""
        if self._browser is not None:
            await self._browser.close()
            self._browser = None
        if self._playwright is not None:
            await self._playwright.stop()
            self._playwright = None

    @property
    def active_contexts(self) -> int:
        """Number of active browser contexts."""
        return self._active_contexts

    @classmethod
    async def shutdown(cls) -> None:
        """Shutdown the singleton instance."""
        if cls._instance is not None:
            await cls._instance.close()
            cls._instance = None


# Convenience function for getting a browser context
@asynccontextmanager
async def get_browser_context() -> AsyncIterator[BrowserContext]:
    """Get a browser context from the shared pool."""
    pool = await BrowserPool.get_instance()
    async with pool.get_context() as context:
        yield context
