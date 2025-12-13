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
  try {
    return new URL(raw, baseUrl).toString();
  } catch {
    return raw;
  }
}

function normalizeSpaces(value: string) {
  return value.replace(/\s+/g, " ").trim();
}

function pickBestSrcsetUrl(srcset: string | null | undefined): string | undefined {
  const raw = asNonEmptyString(srcset ?? undefined);
  if (!raw) return undefined;

  const candidates: Array<{ score: number; url: string }> = [];
  for (const part of raw.split(",")) {
    const chunk = part.trim();
    if (!chunk) continue;
    const pieces = chunk.split(/\s+/);
    const url = asNonEmptyString(pieces[0]);
    if (!url) continue;

    const hint = asNonEmptyString(pieces[1]);
    let score = 0;
    if (hint) {
      const lower = hint.toLowerCase();
      if (lower.endsWith("w")) {
        const num = Number.parseInt(lower.replace(/[^\d]/g, ""), 10);
        score = Number.isFinite(num) ? num : 0;
      } else if (lower.endsWith("x")) {
        const mult = Number.parseFloat(lower.replace(/x$/, ""));
        score = Number.isFinite(mult) ? Math.round(mult * 1000) : 0;
      }
    }

    candidates.push({ score, url });
  }

  if (candidates.length === 0) return undefined;
  candidates.sort((a, b) => a.score - b.score);
  return candidates[candidates.length - 1]!.url;
}

function extractItemId(productUrl: string): string | undefined {
  try {
    const u = new URL(productUrl);
    const mc = asNonEmptyString(u.searchParams.get("mc") ?? undefined);
    if (mc) return mc;
    const match = u.pathname.match(/\/R-p-([0-9a-fA-F-]{8,})/);
    if (match?.[1]) return match[1];
  } catch {
    // ignore
  }
  return undefined;
}

function parsePriceText(text: string | undefined): { price?: number; currency?: string } {
  const raw = asNonEmptyString(text);
  if (!raw) return {};

  const currency = raw.includes("€") ? "EUR" : raw.toUpperCase().includes("CHF") ? "CHF" : undefined;
  const cleaned = raw.replace(/[^\d,.\-]/g, " ").replace(/\s+/g, " ").trim();
  const match = cleaned.match(/-?\d[\d.,]*/);
  if (!match?.[0]) return { ...(currency ? { currency } : {}) };

  const token = match[0];
  const lastComma = token.lastIndexOf(",");
  const lastDot = token.lastIndexOf(".");

  const normalized = (() => {
    if (lastComma !== -1 && lastDot !== -1) {
      if (lastComma > lastDot) return token.replace(/\./g, "").replace(",", ".");
      return token.replace(/,/g, "");
    }
    if (lastComma !== -1) {
      const fracLen = token.length - lastComma - 1;
      if (fracLen === 2) return token.replace(/\./g, "").replace(",", ".");
      return token.replace(/,/g, "");
    }
    if (lastDot !== -1) {
      const fracLen = token.length - lastDot - 1;
      if (fracLen === 2) return token.replace(/,/g, "");
      return token.replace(/\./g, "");
    }
    return token;
  })();

  const num = Number.parseFloat(normalized);
  if (!Number.isFinite(num)) return { ...(currency ? { currency } : {}) };
  return { price: num, ...(currency ? { currency } : {}) };
}

async function clickFirstVisible(page: Page, selectors: string[]) {
  for (const selector of selectors) {
    try {
      const loc = page.locator(selector).first();
      if (await loc.isVisible({ timeout: 1500 })) {
        await loc.click({ timeout: 5000 });
        await page.waitForTimeout(600);
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
    "#didomi-notice-agree-button",
    'button:has-text("Annehmen und Schliessen")',
    'button:has-text("Accept all")',
    'button:has-text("Accept")',
    'button:has-text("Alle akzeptieren")',
    'button:has-text("Allem zustimmen")',
    "#onetrust-accept-btn-handler",
    '[data-testid="uc-accept-all-button"]'
  ];

  if (await clickFirstVisible(page, selectors)) return;
  for (const frame of page.frames()) {
    for (const selector of selectors) {
      try {
        const loc = frame.locator(selector).first();
        if (await loc.isVisible({ timeout: 1500 })) {
          await loc.click({ timeout: 5000 });
          await page.waitForTimeout(600);
          return;
        }
      } catch {
        // ignore
      }
    }
  }
}

const desktopUserAgent =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

export async function scrapeDecathlonChBrandPage(options: {
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
  const userAgent = options.browser?.userAgent ?? options.userAgent ?? desktopUserAgent;
  const locale = options.browser?.locale ?? options.locale ?? "de-CH";

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
      await page.waitForSelector('article:has(a[href*="/p/"])', { timeout: 60_000, state: "attached" });
    } catch {
      // allow empty listing
    }
    await page.waitForTimeout(1200);

    const raw = await page.$$eval('article:has(a[href*="/p/"])', (els: any[]) =>
      els.map((el) => {
        const a = el.querySelector?.('a[href*="/p/"]');
        const img = el.querySelector?.("img");
        const priceEl = el.querySelector?.('.vp-price [data-part="amount"], [data-part="amount"]');
        const url = a?.href ?? null;
        const nameFromImg = img?.alt ? String(img.alt).trim() : null;
        const nameFromLink = a?.textContent ? String(a.textContent).trim() : null;
        const srcset = img?.getAttribute?.("srcset") ?? img?.getAttribute?.("data-srcset") ?? null;
        const imgUrl = img?.currentSrc ?? img?.src ?? img?.getAttribute?.("data-src") ?? null;
        const priceText = priceEl?.textContent ? String(priceEl.textContent).trim() : null;
        return { url, name: nameFromImg || nameFromLink, priceText, imgUrl, srcset };
      })
    );

    const products: DiscoveredProduct[] = [];
    for (const item of raw) {
      const urlRaw = asNonEmptyString(item.url);
      const nameRaw = asNonEmptyString(item.name);
      if (!urlRaw || !nameRaw) continue;

      const url = urlRaw.split("?", 1)[0]!.trim();
      if (!url) continue;

      const itemId = extractItemId(urlRaw) ?? url;
      const { price, currency: parsedCurrency } = parsePriceText(
        typeof item.priceText === "string" ? item.priceText : undefined
      );
      const currency = options.currency ?? parsedCurrency ?? (price !== undefined ? "CHF" : undefined);

      const imageCandidate = asNonEmptyString(
        pickBestSrcsetUrl(typeof item.srcset === "string" ? item.srcset : undefined) ??
          (typeof item.imgUrl === "string" ? item.imgUrl : undefined)
      );
      const imageUrl = normalizeUrl(baseUrl, imageCandidate);

      products.push({
        sourceSlug: options.sourceSlug,
        itemId,
        name: normalizeSpaces(nameRaw),
        url,
        price,
        currency,
        imageUrl
      });
    }

      return { products };
    } finally {
      await page.close().catch(() => undefined);
    }
  });
}
