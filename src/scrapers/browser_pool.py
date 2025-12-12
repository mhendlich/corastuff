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
        self._browsers: dict[str, Browser] = {}
        self._active_contexts: int = 0
        self._browser_launch_lock = asyncio.Lock()

    @classmethod
    async def get_instance(cls) -> BrowserPool:
        """Get or create the singleton browser pool instance."""
        if cls._instance is None:
            async with cls._lock:
                if cls._instance is None:
                    cls._instance = cls()
        return cls._instance

    async def _ensure_browser(self, browser_type: str) -> Browser:
        """Ensure the requested browser engine is started, launching if necessary."""
        normalized = (browser_type or "chromium").strip().lower()
        if normalized not in {"chromium", "firefox", "webkit"}:
            raise ValueError(f"Unsupported browser_type: {browser_type!r}")

        async with self._browser_launch_lock:
            existing = self._browsers.get(normalized)
            if existing is not None and existing.is_connected():
                return existing

            if self._playwright is None:
                self._playwright = await async_playwright().start()

            launcher = getattr(self._playwright, normalized)
            browser = await launcher.launch(headless=True)
            self._browsers[normalized] = browser
            return browser

    @asynccontextmanager
    async def get_context(
        self,
        *,
        browser_type: str = "chromium",
        user_agent: str | None = None,
        locale: str | None = None,
        viewport: dict[str, int] | None = None,
        init_scripts: list[str] | None = None,
    ) -> AsyncIterator[BrowserContext]:
        """
        Get a fresh browser context from the pool.

        Contexts are isolated (separate cookies, storage) but share the browser process.
        """
        browser = await self._ensure_browser(browser_type)
        context_kwargs: dict[str, object] = {}
        if user_agent:
            context_kwargs["user_agent"] = user_agent
        if locale:
            context_kwargs["locale"] = locale
        if viewport:
            context_kwargs["viewport"] = viewport

        context = await browser.new_context(**context_kwargs)
        if init_scripts:
            for script in init_scripts:
                try:
                    await context.add_init_script(script)
                except Exception:
                    # Best-effort: individual scripts may fail on some sites.
                    continue
        self._active_contexts += 1
        try:
            yield context
        finally:
            self._active_contexts -= 1
            await context.close()

    async def close(self) -> None:
        """Close the browser and cleanup resources."""
        for browser in list(self._browsers.values()):
            try:
                await browser.close()
            except Exception:
                continue
        self._browsers = {}
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
async def get_browser_context(
    *,
    browser_type: str = "chromium",
    user_agent: str | None = None,
    locale: str | None = None,
    viewport: dict[str, int] | None = None,
    init_scripts: list[str] | None = None,
) -> AsyncIterator[BrowserContext]:
    """Get a browser context from the shared pool."""
    pool = await BrowserPool.get_instance()
    async with pool.get_context(
        browser_type=browser_type,
        user_agent=user_agent,
        locale=locale,
        viewport=viewport,
        init_scripts=init_scripts,
    ) as context:
        yield context
