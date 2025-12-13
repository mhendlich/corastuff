import type { DiscoveredProduct } from "@corastuff/shared";
import { chromium, type Page } from "playwright";

function asNonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function normalizeSpaces(value: string) {
  return value.replace(/\s+/g, " ").trim();
}

function parsePriceText(text: string | undefined): { price?: number; currency?: string } {
  const raw = asNonEmptyString(text);
  if (!raw) return {};

  const currency = raw.includes("€") ? "EUR" : raw.toUpperCase().includes("CHF") ? "CHF" : undefined;

  const cleaned = raw.replace(/[^\d,.\-]/g, " ").replace(/\s+/g, " ").trim();
  const match = cleaned.match(/-?\d{1,10}(?:[.,]\d{1,2})?/);
  if (!match) return { ...(currency ? { currency } : {}) };

  const token = match[0]!;
  const hasComma = token.includes(",");
  const hasDot = token.includes(".");
  const normalized =
    hasComma && hasDot ? token.replace(/\./g, "").replace(",", ".") : hasComma ? token.replace(",", ".") : token;
  const num = Number.parseFloat(normalized);
  if (!Number.isFinite(num)) return { ...(currency ? { currency } : {}) };
  return { price: num, ...(currency ? { currency } : {}) };
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

function extractCssUrl(styleText: string | undefined): string | undefined {
  const raw = asNonEmptyString(styleText);
  if (!raw) return undefined;
  const match = raw.match(/url\\((?:\"|')?(.*?)(?:\"|')?\\)/i);
  return asNonEmptyString(match?.[1]);
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

export async function scrapeBergzeitBrandListing(options: {
  sourceSlug: string;
  listingUrl: string;
  baseUrl?: string;
  userAgent?: string;
  locale?: string;
  log?: (message: string) => void;
}): Promise<{ products: DiscoveredProduct[] }> {
  const baseUrl = options.baseUrl ?? new URL(options.listingUrl).origin;
  const userAgent =
    options.userAgent ??
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
  const locale = options.locale ?? "de-DE";

  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext({ userAgent, locale });
    const page = await context.newPage();

    options.log?.(`Loading ${options.listingUrl}`);
    await page.goto(options.listingUrl, { waitUntil: "domcontentloaded", timeout: 90_000 });
    await handleCookieConsent(page);

    await page.waitForSelector(".product-box", { timeout: 60_000 });
    await page.waitForSelector(".product-box__image-container img", { timeout: 60_000 });
    await page.waitForTimeout(400);

    const raw = await page.$$eval(".product-box", (nodes) =>
      nodes.map((node) => {
        const el = node as any;
        const itemId = el.getAttribute?.("data-item-id") ?? null;
        const href = el.getAttribute?.("href") ?? el.querySelector?.("a")?.getAttribute?.("href") ?? null;
        const name = el.querySelector?.(".product-box-content__name")?.textContent ?? null;
        const priceText = el.querySelector?.(".product-box-content__price")?.textContent ?? null;
        const container = el.querySelector?.(".product-box__image-container");
        const containerStyle = container?.getAttribute?.("style") ?? null;
        const img = container?.querySelector?.("img") ?? el.querySelector?.(".product-box__image-container img");
        const src = img?.getAttribute?.("src") ?? null;
        const dataSrc = img?.getAttribute?.("data-src") ?? null;
        const srcset = img?.getAttribute?.("srcset") ?? null;
        const dataSrcset = img?.getAttribute?.("data-srcset") ?? null;
        const source = container?.querySelector?.("source") ?? el.querySelector?.(".product-box__image-container source");
        const sourceSrcset = source?.getAttribute?.("srcset") ?? source?.getAttribute?.("data-srcset") ?? null;
        return { itemId, href, name, priceText, src, dataSrc, srcset, dataSrcset, sourceSrcset, containerStyle };
      })
    );

    const products: DiscoveredProduct[] = [];
    const seen = new Set<string>();

    for (const item of raw) {
      const name = normalizeSpaces(item.name ?? "");
      if (!name) continue;

      const itemId = asNonEmptyString(item.itemId);
      const url = normalizeUrl(baseUrl, asNonEmptyString(item.href ?? undefined));
      const { price, currency } = parsePriceText(item.priceText ?? undefined);

      const imageRaw =
        pickBestSrcsetUrl(item.sourceSrcset) ??
        pickBestSrcsetUrl(item.srcset) ??
        pickBestSrcsetUrl(item.dataSrcset) ??
        asNonEmptyString(item.src) ??
        asNonEmptyString(item.dataSrc) ??
        extractCssUrl(item.containerStyle ?? undefined) ??
        undefined;
      const imageUrl = normalizeUrl(baseUrl, imageRaw);

      const dedupeKey = itemId ?? url ?? name;
      if (seen.has(dedupeKey)) continue;
      seen.add(dedupeKey);

      products.push({
        sourceSlug: options.sourceSlug,
        itemId,
        name,
        url,
        price,
        currency: price !== undefined ? currency : undefined,
        imageUrl
      });
    }

    await context.close();
    return { products };
  } finally {
    await browser.close();
  }
}
