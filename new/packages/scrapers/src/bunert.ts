import type { DiscoveredProduct } from "@corastuff/shared";
import type { Page } from "playwright";
import { withPlaywrightContext, type PlaywrightContextProfile, type PlaywrightRunArtifactsOptions } from "./playwrightContext.js";

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

function coercePrice(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) return value;
  if (typeof value === "string") {
    const raw = value.trim();
    if (!raw) return undefined;
    const cleaned = raw.replace(/[^\d,.\-]/g, " ").replace(/\s+/g, " ").trim();
    const match = cleaned.match(/-?\d{1,10}(?:[.,]\d{1,2})?/);
    if (!match) return undefined;
    const token = match[0]!;
    const hasComma = token.includes(",");
    const hasDot = token.includes(".");
    const normalized =
      hasComma && hasDot ? token.replace(/\./g, "").replace(",", ".") : hasComma ? token.replace(",", ".") : token;
    const num = Number.parseFloat(normalized);
    return Number.isFinite(num) && num > 0 ? num : undefined;
  }
  return undefined;
}

const desktopUserAgent =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

type DataLayerProduct = { name?: unknown; id?: unknown; price?: unknown };

async function extractFromDataLayer(page: Page): Promise<{
  name?: string;
  itemId?: string;
  price?: number;
  currency?: string;
}> {
  const result: unknown = await page.evaluate(() => {
    const dataLayer = (globalThis as any)?.window?.dataLayer ?? (globalThis as any)?.dataLayer ?? [];
    if (!Array.isArray(dataLayer)) return null;

    for (const entry of dataLayer) {
      const ecommerce = entry?.ecommerce;
      const detail = ecommerce?.detail;
      const products = detail?.products;
      if (!Array.isArray(products) || products.length === 0) continue;
      const first = products.find((p) => typeof p === "object" && p !== null && !Array.isArray(p)) ?? products[0];
      return {
        product: first,
        currencyCode: typeof ecommerce?.currencyCode === "string" ? ecommerce.currencyCode : null
      };
    }

    return null;
  });

  if (typeof result !== "object" || result === null) return {};
  const obj = result as { product?: unknown; currencyCode?: unknown };

  const productRaw = obj.product;
  const product =
    typeof productRaw === "object" && productRaw !== null && !Array.isArray(productRaw)
      ? (productRaw as DataLayerProduct)
      : undefined;

  const name = product ? asNonEmptyString(product.name) : undefined;
  const itemId = product ? asNonEmptyString(product.id) : undefined;
  const price = product ? coercePrice(product.price) : undefined;
  const currency = asNonEmptyString(obj.currencyCode)?.toUpperCase();

  return {
    ...(name ? { name } : {}),
    ...(itemId ? { itemId } : {}),
    ...(price !== undefined ? { price } : {}),
    ...(currency ? { currency } : {})
  };
}

async function safeGetMeta(page: Page, selector: string): Promise<string | undefined> {
  try {
    return asNonEmptyString(await page.locator(selector).first().getAttribute("content"));
  } catch {
    return undefined;
  }
}

export async function scrapeBunertProductPage(options: {
  sourceSlug: string;
  productUrl: string;
  currency?: string;
  browser?: PlaywrightContextProfile;
  artifacts?: PlaywrightRunArtifactsOptions;
  userAgent?: string;
  locale?: string;
  log?: (message: string) => void;
}): Promise<{ products: DiscoveredProduct[] }> {
  const userAgent = options.browser?.userAgent ?? options.userAgent ?? desktopUserAgent;
  const locale = options.browser?.locale ?? options.locale ?? "de-DE";
  const browser: PlaywrightContextProfile = {
    ...options.browser,
    userAgent,
    locale,
    viewport: options.browser?.viewport ?? { width: 1400, height: 900 },
    stealth: options.browser?.stealth ?? true
  };

  return await withPlaywrightContext(
    browser,
    async (context) => {
    const page = await context.newPage();
    try {
      options.log?.(`Loading ${options.productUrl}`);
      await page.goto(options.productUrl, { waitUntil: "domcontentloaded", timeout: 90_000 });
      await page.waitForTimeout(400);

      const baseUrl = (() => {
        try {
          return new URL(options.productUrl).origin;
        } catch {
          return "https://www.bunert.de/";
        }
      })();

      const fromDl = await extractFromDataLayer(page);
      const titleFallback = (() => {
        try {
          return page?.title?.();
        } catch {
          return null;
        }
      })();

      const rawTitle = titleFallback ? await titleFallback : undefined;
      const titleName = asNonEmptyString(rawTitle)?.split("|")[0]?.trim();
      const name = fromDl.name ?? titleName;
      if (!name) return { products: [] };

      const url = page.url();
      const imageUrl = normalizeUrl(baseUrl, await safeGetMeta(page, 'meta[property="og:image"]'));

      const currency =
        asNonEmptyString(fromDl.currency) ??
        asNonEmptyString(options.currency)?.toUpperCase() ??
        (fromDl.price !== undefined ? "EUR" : undefined);

      return {
        products: [
          {
            sourceSlug: options.sourceSlug,
            itemId: fromDl.itemId,
            name,
            url,
            price: fromDl.price,
            currency: fromDl.price !== undefined ? currency : undefined,
            imageUrl
          }
        ]
      };
    } finally {
      await page.close().catch(() => undefined);
    }
    },
    { artifacts: options.artifacts }
  );
}
