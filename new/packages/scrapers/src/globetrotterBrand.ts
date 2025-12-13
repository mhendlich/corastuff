import type { DiscoveredProduct } from "@corastuff/shared";
import type { Page } from "playwright";
import { withPlaywrightContext, type PlaywrightContextProfile } from "./playwrightContext.js";

function asNonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function normalizeSpaces(value: string) {
  return value.replace(/\s+/g, " ").trim();
}

function pickBestSrcsetUrl(srcset: string | null | undefined): string | undefined {
  const raw = asNonEmptyString(srcset ?? undefined);
  if (!raw) return undefined;
  const candidates = raw
    .split(",")
    .map((c) => c.trim().split(/\s+/, 1)[0]?.trim())
    .filter(Boolean) as string[];
  if (candidates.length === 0) return undefined;

  for (const ext of [".webp", ".jpeg", ".jpg", ".png"]) {
    for (let i = candidates.length - 1; i >= 0; i -= 1) {
      const u = candidates[i]!;
      if (u.toLowerCase().includes(ext)) return u;
    }
  }

  return candidates[candidates.length - 1];
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

function extractItemId(url: string): string | undefined {
  try {
    const u = new URL(url);
    const sku = asNonEmptyString(u.searchParams.get("sku") ?? undefined);
    if (sku) return sku;

    const path = u.pathname.replace(/\/+$/, "");
    const match = path.match(/-(\d{5,})$/);
    if (match?.[1]) return match[1];
    const tail = path.split("/").filter(Boolean).slice(-1)[0];
    return asNonEmptyString(tail);
  } catch {
    return undefined;
  }
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

async function handleCookieConsent(page: Page) {
  const selectors = [
    'button:has-text("Alle akzeptieren")',
    'button:has-text("Akzeptieren")',
    "#onetrust-accept-btn-handler",
    '[data-testid="uc-accept-all-button"]',
    "button#uc-btn-accept-banner"
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

export async function scrapeGlobetrotterBrandPage(options: {
  sourceSlug: string;
  listingUrl: string;
  baseUrl?: string;
  currency?: string;
  browser?: PlaywrightContextProfile;
  userAgent?: string;
  locale?: string;
  log?: (message: string) => void;
}): Promise<{ products: DiscoveredProduct[] }> {
  const baseUrl = options.baseUrl ?? new URL(options.listingUrl).origin;
  const userAgent =
    options.browser?.userAgent ??
    options.userAgent ??
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
  const locale = options.browser?.locale ?? options.locale ?? "de-DE";

  const browser: PlaywrightContextProfile = {
    ...options.browser,
    userAgent,
    locale,
    viewport: options.browser?.viewport ?? { width: 1920, height: 1080 },
    stealth: options.browser?.stealth ?? true
  };

  return await withPlaywrightContext(browser, async (context) => {
    const page = await context.newPage();
    try {
      options.log?.(`Loading ${options.listingUrl}`);
      await page.goto(options.listingUrl, { waitUntil: "domcontentloaded", timeout: 90_000 });
      await handleCookieConsent(page);

    try {
      await page.waitForSelector("a.pdpLink[href]", { timeout: 60_000, state: "attached" });
    } catch {
      // allow empty listings; extraction will return []
    }
    await page.waitForTimeout(700);

    const raw = await page.$$eval("a.pdpLink[href]", (els: any[]) =>
      els.map((el) => {
        const href = el.getAttribute?.("href") || "";
        const brand =
          (el.querySelector(".brand")?.textContent || "").replace(/\s+/g, " ").trim() || undefined;
        const name =
          (el.querySelector(".name")?.textContent || "").replace(/\s+/g, " ").trim() ||
          (el.querySelector(".sr-only")?.textContent || "").replace(/\s+/g, " ").trim() ||
          undefined;
        const price =
          (el.querySelector(".price")?.textContent || "").replace(/\s+/g, " ").trim() || undefined;
        const img =
          el.querySelector?.("img.js-main-list-image") ||
          el.querySelector?.("img");
        const src = img?.getAttribute?.("src") || img?.getAttribute?.("data-src") || undefined;
        const srcset =
          img?.getAttribute?.("srcset") ||
          img?.getAttribute?.("data-srcset") ||
          img?.getAttribute?.("srcSet") ||
          undefined;
        return { href, brand, name, price, src, srcset };
      })
    );

    const products: DiscoveredProduct[] = [];
    for (const item of raw) {
      const href = asNonEmptyString(item.href);
      const nameRaw = asNonEmptyString(item.name);
      if (!href || !nameRaw) continue;

      const url = new URL(href, baseUrl).toString();
      const brand = asNonEmptyString(item.brand);
      const name = normalizeSpaces(brand && !nameRaw.toLowerCase().includes(brand.toLowerCase()) ? `${brand} ${nameRaw}` : nameRaw);

      const { price, currency: parsedCurrency } = parsePriceText(item.price);
      const currency = options.currency ?? parsedCurrency;

      const imageCandidate = asNonEmptyString(pickBestSrcsetUrl(item.srcset) ?? item.src);
      const imageUrl = imageCandidate ? new URL(imageCandidate, baseUrl).toString() : undefined;

      products.push({
        sourceSlug: options.sourceSlug,
        itemId: extractItemId(url),
        name,
        url,
        price,
        currency,
        imageUrl
      });
    }

    await page.close();
      return { products };
    } finally {
      await page.close().catch(() => undefined);
    }
  });
}
