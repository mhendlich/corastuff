import type { DiscoveredProduct } from "@corastuff/shared";
import type { Page } from "playwright";
import { withPlaywrightContext, type PlaywrightContextProfile } from "./playwrightContext.js";

function asNonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function normalizeUrl(baseUrl: string, value: string | undefined): string | undefined {
  const raw = asNonEmptyString(value);
  if (!raw) return undefined;
  if (raw.startsWith("//")) return `https:${raw}`;
  if (raw.startsWith("/")) return new URL(raw, baseUrl).toString();
  return raw;
}

function isAsin(value: string | undefined): value is string {
  const raw = asNonEmptyString(value);
  if (!raw || raw.length !== 10) return false;
  for (let i = 0; i < raw.length; i += 1) {
    const c = raw.charCodeAt(i);
    const ok =
      (c >= 48 && c <= 57) || // 0-9
      (c >= 65 && c <= 90); // A-Z
    if (!ok) return false;
  }
  return true;
}

function isGuid(value: string | undefined) {
  const raw = asNonEmptyString(value);
  if (!raw || raw.length !== 36) return false;
  for (let i = 0; i < raw.length; i += 1) {
    const c = raw.charCodeAt(i);
    if (i === 8 || i === 13 || i === 18 || i === 23) {
      if (c !== 45) return false;
      continue;
    }
    const isHex =
      (c >= 48 && c <= 57) || // 0-9
      (c >= 65 && c <= 70) || // A-F
      (c >= 97 && c <= 102); // a-f
    if (!isHex) return false;
  }
  return true;
}

function extractAmazonStorePageUrl(baseUrl: string, href: string): { guid: string; url: string } | null {
  const abs = normalizeUrl(baseUrl, href);
  if (!abs) return null;
  let u: URL;
  try {
    u = new URL(abs);
  } catch {
    return null;
  }

  const parts = u.pathname.split("/").filter(Boolean);
  const pageIdx = parts.lastIndexOf("page");
  if (pageIdx === -1 || pageIdx + 1 >= parts.length) return null;
  const guid = parts[pageIdx + 1];
  if (!isGuid(guid)) return null;
  return { guid, url: u.toString() };
}

function parsePriceText(text: string | undefined): { price?: number; currency?: string } {
  const raw = asNonEmptyString(text);
  if (!raw) return {};

  const currency = raw.includes("€") ? "EUR" : raw.toUpperCase().includes("CHF") ? "CHF" : undefined;
  const cleaned = raw
    .replace(/[^\d,.\-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  const match = cleaned.match(/-?\d{1,6}(?:[.,]\d{1,2})?/);
  if (!match) return { ...(currency ? { currency } : {}) };
  const num = Number.parseFloat(match[0]!.replace(/\./g, "").replace(",", "."));
  if (!Number.isFinite(num)) return { ...(currency ? { currency } : {}) };
  return { price: num, ...(currency ? { currency } : {}) };
}

async function clickFirstVisible(page: Page, selectors: string[]) {
  for (const selector of selectors) {
    try {
      const loc = page.locator(selector).first();
      if (await loc.isVisible({ timeout: 1500 })) {
        await loc.click({ timeout: 5000 });
        await page.waitForTimeout(800);
        return true;
      }
    } catch {
      // ignore
    }
  }
  return false;
}

async function handleAmazonCookieConsent(page: Page) {
  const selectors = [
    "#sp-cc-accept",
    "input#sp-cc-accept",
    'button:has-text("Alle Cookies akzeptieren")',
    'button:has-text("Alle akzeptieren")',
    'button:has-text("Zustimmen")',
    'button:has-text("Accept cookies")',
    'button:has-text("Accept all")'
  ];
  if (await clickFirstVisible(page, selectors)) return;
  for (const frame of page.frames()) {
    for (const selector of selectors) {
      try {
        const loc = frame.locator(selector).first();
        if (await loc.isVisible({ timeout: 1500 })) {
          await loc.click({ timeout: 5000 });
          await page.waitForTimeout(800);
          return;
        }
      } catch {
        // ignore
      }
    }
  }
}

async function clickSeeMore(page: Page) {
  const selectors = [
    'button:has-text("Mehr anzeigen")',
    'a:has-text("Mehr anzeigen")',
    'button:has-text("See more")',
    'a:has-text("See more")'
  ];
  await clickFirstVisible(page, selectors);
}

async function looksBlocked(page: Page) {
  try {
    const html = (await page.content()).toLowerCase();
    return html.includes("robot check") || html.includes("captcha") || html.includes("geben sie die zeichen");
  } catch {
    return false;
  }
}

async function discoverStorePages(page: Page, baseUrl: string, maxPages: number): Promise<string[]> {
  const hrefs = await page.$$eval("a[href]", (els: any[]) =>
    els.map((el) => el?.getAttribute?.("href")).filter(Boolean)
  );

  const candidates: Array<{ guid: string; url: string }> = [];
  const seen = new Set<string>();
  for (const raw of hrefs) {
    const href = typeof raw === "string" ? raw : "";
    if (!href) continue;
    if (!href.toLowerCase().includes("/stores/")) continue;
    if (!href.toLowerCase().includes("/page/")) continue;
    const parsed = extractAmazonStorePageUrl(baseUrl, href);
    if (!parsed) continue;
    if (seen.has(parsed.guid)) continue;
    seen.add(parsed.guid);
    candidates.push(parsed);
    if (candidates.length >= maxPages) break;
  }

  return candidates.map((c) => c.url);
}

async function collectAsins(page: Page): Promise<Set<string>> {
  const asins = await page.$$eval("[data-asin]", (els: any[]) =>
    els.map((el) => el?.getAttribute?.("data-asin")).filter(Boolean)
  );

  return new Set(asins.filter((a): a is string => typeof a === "string"));
}

async function scrollToLoadAll(page: Page, options: { maxRounds: number; log?: (m: string) => void }) {
  const seen = new Set<string>();
  let stagnant = 0;

  for (let round = 0; round < options.maxRounds; round += 1) {
    await page.waitForTimeout(1500 + Math.round(Math.random() * 800));
    const current = await collectAsins(page);
    const before = seen.size;
    for (const asin of current) seen.add(asin);
    const after = seen.size;
    if (after === before) {
      stagnant += 1;
    } else {
      stagnant = 0;
    }

    options.log?.(`Scroll round ${round + 1}/${options.maxRounds}: seen ${seen.size} ASINs`);
    if (stagnant >= 2) break;

    await clickSeeMore(page);
    await page.evaluate("window.scrollTo(0, document.body.scrollHeight)");
  }
}

type RawAmazonProduct = {
  asin?: string;
  href?: string;
  name?: string;
  priceText?: string;
  imageUrl?: string;
};

async function extractProducts(page: Page): Promise<RawAmazonProduct[]> {
  return await page.$$eval("[data-asin]", (els) => {
    const out: RawAmazonProduct[] = [];
    const isAsin = (v: string | null) => {
      if (!v) return false;
      const s = v.trim();
      if (s.length !== 10) return false;
      for (let i = 0; i < s.length; i += 1) {
        const c = s.charCodeAt(i);
        const ok = (c >= 48 && c <= 57) || (c >= 65 && c <= 90);
        if (!ok) return false;
      }
    return true;
  };

    const pickText = (root: any, selectors: string[]) => {
      for (const sel of selectors) {
        const el = root.querySelector(sel);
        const text = el?.textContent?.replace(/\s+/g, " ").trim();
        if (text) return text;
      }
      return undefined;
    };

    for (const el of els.slice(0, 4000)) {
      const asin = (el as any)?.getAttribute?.("data-asin") ?? null;
      if (!isAsin(asin)) continue;

      const container: any = el;
      const link =
        container.querySelector('a[href*="/dp/"], a[href*="/gp/product/"]') ??
        (container.getAttribute("href") ? container : null);
      const href = link?.getAttribute("href") ?? undefined;

      const name =
        (link?.getAttribute("aria-label")?.replace(/\s+/g, " ").trim() || undefined) ??
        pickText(container, ["h2 span", "span.a-size-base-plus", "span.a-size-medium", 'span[role="heading"]']);

      const priceText = pickText(container, [
        ".a-price .a-offscreen",
        "span[data-a-color='price'] .a-offscreen",
        "span.a-price-whole"
      ]);

      const img = container.querySelector("img");
      let imageUrl = img?.getAttribute("src") ?? img?.getAttribute("data-src") ?? undefined;
      if (!imageUrl) {
        const dynamic = img?.getAttribute("data-a-dynamic-image");
        if (dynamic) {
          try {
            const parsed = JSON.parse(dynamic) as Record<string, unknown>;
            const first = Object.keys(parsed)[0];
            if (first) imageUrl = first;
          } catch {
            // ignore
          }
        }
      }

      out.push({
        asin: asin!.trim(),
        href,
        name,
        priceText,
        imageUrl
      });
    }

    return out;
  });
}

function dedupeProducts(products: DiscoveredProduct[]): DiscoveredProduct[] {
  const byAsin = new Map<string, DiscoveredProduct>();
  for (const p of products) {
    const key = p.itemId?.trim().toUpperCase();
    if (!key) continue;
    const existing = byAsin.get(key);
    if (!existing) {
      byAsin.set(key, p);
      continue;
    }
    const existingHasPrice = typeof existing.price === "number" && Number.isFinite(existing.price);
    const currentHasPrice = typeof p.price === "number" && Number.isFinite(p.price);
    if (!existingHasPrice && currentHasPrice) {
      byAsin.set(key, p);
      continue;
    }
    if (existingHasPrice && currentHasPrice && (p.price ?? Infinity) < (existing.price ?? Infinity)) {
      byAsin.set(key, p);
    }
  }
  return Array.from(byAsin.values());
}

export async function scrapeAmazonStorefront(options: {
  sourceSlug: string;
  storeUrl: string;
  baseUrl?: string;
  currency?: string;
  browser?: PlaywrightContextProfile;
  userAgent?: string;
  locale?: string;
  maxStorePages?: number;
  maxScrollRounds?: number;
  log?: (message: string) => void;
}): Promise<{ products: DiscoveredProduct[] }> {
  const baseUrl = options.baseUrl ?? new URL(options.storeUrl).origin;
  const userAgent =
    options.browser?.userAgent ??
    options.userAgent ??
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
  const locale = options.browser?.locale ?? options.locale ?? "de-DE";
  const maxStorePages = Math.min(25, Math.max(1, Math.trunc(options.maxStorePages ?? 20)));
  const maxScrollRounds = Math.min(30, Math.max(1, Math.trunc(options.maxScrollRounds ?? 20)));

  const browser: PlaywrightContextProfile = {
    ...options.browser,
    userAgent,
    locale,
    viewport: options.browser?.viewport ?? { width: 1920, height: 1080 },
    stealth: options.browser?.stealth ?? true
  };

  return await withPlaywrightContext(browser, async (context) => {
    const page = await context.newPage();
    options.log?.(`Loading Amazon store ${options.storeUrl}`);
    await page.goto(options.storeUrl, { waitUntil: "domcontentloaded", timeout: 90_000 });
    await handleAmazonCookieConsent(page);
    if (await looksBlocked(page)) {
      options.log?.("Amazon returned a robot-check/captcha page; skipping scrape");
      return { products: [] };
    }

    const discoveredPages = await discoverStorePages(page, baseUrl, maxStorePages);
    const pages = discoveredPages.length > 0 ? discoveredPages : [page.url() || options.storeUrl];
    options.log?.(`Discovered ${pages.length} store page(s)`);

    const all: DiscoveredProduct[] = [];
    for (let idx = 0; idx < pages.length; idx += 1) {
      const url = pages[idx]!;
      options.log?.(`Scraping store page ${idx + 1}/${pages.length}: ${url}`);
      if (page.url() !== url) {
        await page.goto(url, { waitUntil: "domcontentloaded", timeout: 90_000 });
        await handleAmazonCookieConsent(page);
        if (await looksBlocked(page)) {
          options.log?.("Amazon returned a robot-check/captcha page while paging; stopping");
          break;
        }
      }

      await scrollToLoadAll(page, { maxRounds: maxScrollRounds, log: options.log });
      const raw = await extractProducts(page);

      for (const item of raw) {
        const asin = item.asin?.trim().toUpperCase();
        const name = asNonEmptyString(item.name);
        if (!isAsin(asin) || !name) continue;

        const url = normalizeUrl(baseUrl, item.href) ?? (asin ? `${baseUrl}/dp/${asin}` : undefined);
        const imageUrl = normalizeUrl(baseUrl, item.imageUrl);
        const { price, currency: parsedCurrency } = parsePriceText(item.priceText);

        all.push({
          sourceSlug: options.sourceSlug,
          itemId: asin,
          name,
          url,
          price,
          currency: options.currency ?? parsedCurrency ?? (price !== undefined ? "EUR" : undefined),
          imageUrl
        });
      }

      await page.waitForTimeout(800 + Math.round(Math.random() * 1200));
    }

    return { products: dedupeProducts(all) };
  });
}
