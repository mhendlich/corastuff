import type { DiscoveredProduct } from "@corastuff/shared";

type ShopifyVariant = {
  available?: boolean;
  price?: string | number;
};

type ShopifyImage = {
  src?: string;
  width?: number | string;
  height?: number | string;
};

type ShopifyProduct = {
  id?: number | string;
  title?: string;
  handle?: string;
  variants?: ShopifyVariant[];
  images?: Array<string | ShopifyImage>;
  image?: ShopifyImage;
};

function asNonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function asCurrencyCode(value: unknown): string | undefined {
  const s = asNonEmptyString(value);
  if (!s) return undefined;
  const code = s.toUpperCase();
  return /^[A-Z]{3}$/.test(code) ? code : undefined;
}

function parseShopifyCurrencyFromHtml(html: string): string | undefined {
  const jsonMatch = html.match(/Shopify\.currency\s*=\s*(\{[^;]+?\})\s*;/);
  if (jsonMatch?.[1]) {
    try {
      const obj = JSON.parse(jsonMatch[1]) as { active?: unknown };
      const active = asCurrencyCode(obj?.active);
      if (active) return active;
    } catch {
      // ignore
    }
  }

  const activeMatch = html.match(/"active"\s*:\s*"([A-Z]{3})"/);
  if (activeMatch?.[1]) return asCurrencyCode(activeMatch[1]);

  const dotMatch = html.match(/Shopify\.currency\.active\s*=\s*['"]([A-Z]{3})['"]/);
  if (dotMatch?.[1]) return asCurrencyCode(dotMatch[1]);

  return undefined;
}

async function inferShopifyCurrency(options: {
  sourceUrl: string;
  fetchImpl: typeof fetch;
  headers: Record<string, string>;
  log?: (message: string) => void;
}): Promise<string | undefined> {
  try {
    const resp = await options.fetchImpl(options.sourceUrl, {
      redirect: "follow",
      headers: {
        ...options.headers,
        accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8"
      }
    });
    if (!resp.ok) return undefined;
    const html = await resp.text();
    const currency = parseShopifyCurrencyFromHtml(html);
    if (currency) options.log?.(`Inferred Shopify currency: ${currency}`);
    return currency;
  } catch {
    return undefined;
  }
}

function pickVariant(product: ShopifyProduct): ShopifyVariant | undefined {
  const variants = product.variants;
  if (!Array.isArray(variants) || variants.length === 0) return undefined;
  const available = variants.find((v) => typeof v === "object" && v !== null && v.available === true);
  return available ?? variants[0];
}

function coercePrice(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) return value;
  if (typeof value === "string") {
    const parsed = Number.parseFloat(value);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
  }
  return undefined;
}

function normalizeUrl(baseUrl: string, value: string | undefined): string | undefined {
  const raw = asNonEmptyString(value);
  if (!raw) return undefined;
  if (raw.startsWith("//")) return `https:${raw}`;
  if (raw.startsWith("/")) return new URL(raw, baseUrl).toString();
  return raw;
}

function imgWidth(i: ShopifyImage): number {
  const w = i.width;
  const num = typeof w === "number" ? w : typeof w === "string" ? Number.parseInt(w, 10) : 0;
  return Number.isFinite(num) ? num : 0;
}

function pickImageUrl(baseUrl: string, product: ShopifyProduct): string | undefined {
  const images = product.images;
  if (Array.isArray(images) && images.length > 0) {
    let best: ShopifyImage | undefined;
    let bestRaw: string | undefined;
    for (const img of images) {
      if (typeof img === "string") {
        if (!bestRaw) bestRaw = img;
        continue;
      }
      if (typeof img === "object" && img !== null) {
        if (!best || imgWidth(img) >= imgWidth(best)) best = img;
      }
    }

    const fromBest = best ? normalizeUrl(baseUrl, asNonEmptyString(best.src)) : undefined;
    if (fromBest) return fromBest;
    if (bestRaw) return normalizeUrl(baseUrl, bestRaw);
  }

  if (product.image && typeof product.image === "object") {
    const src = normalizeUrl(baseUrl, asNonEmptyString(product.image.src));
    if (src) return src;
  }

  return undefined;
}

export async function scrapeShopifyCollectionProductsJson(options: {
  sourceSlug: string;
  sourceUrl: string;
  collectionProductsJsonUrl: string;
  productPathPrefix?: string;
  currency?: string;
  fetchImpl?: typeof fetch;
  headers?: Record<string, string>;
  log?: (message: string) => void;
}): Promise<{ products: DiscoveredProduct[] }> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const headers: Record<string, string> = {
    "user-agent":
      "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
    accept: "application/json,text/plain,*/*",
    "accept-language": "de-DE,de;q=0.9,en-US;q=0.8,en;q=0.7",
    referer: options.sourceUrl,
    ...options.headers
  };

  const currency =
    options.currency ??
    (await inferShopifyCurrency({ sourceUrl: options.sourceUrl, fetchImpl, headers, log: options.log })) ??
    "EUR";

  const productPathPrefix = asNonEmptyString(options.productPathPrefix) ?? "/products/";
  const normalizedProductPathPrefix = productPathPrefix.startsWith("/") ? productPathPrefix : `/${productPathPrefix}`;

  const products: DiscoveredProduct[] = [];
  const seen = new Set<string>();
  let page = 1;

  while (true) {
    const url = (() => {
      const u = new URL(options.collectionProductsJsonUrl);
      u.searchParams.set("limit", "250");
      u.searchParams.set("page", String(page));
      return u.toString();
    })();
    options.log?.(`Loading ${url}`);
    const resp = await fetchImpl(url, { headers, redirect: "follow" });
    if (!resp.ok) {
      throw new Error(`Shopify collection fetch failed: ${resp.status} ${resp.statusText}`);
    }
    const payload: unknown = await resp.json();
    const rawProducts = (payload as { products?: unknown }).products;
    if (!Array.isArray(rawProducts) || rawProducts.length === 0) break;

    for (const raw of rawProducts) {
      if (typeof raw !== "object" || raw === null) continue;
      const p = raw as ShopifyProduct;

      const itemId = p.id !== undefined ? String(p.id) : undefined;
      if (itemId && seen.has(itemId)) continue;
      if (itemId) seen.add(itemId);

      const name = asNonEmptyString(p.title);
      if (!name) continue;

      const handle = asNonEmptyString(p.handle);
      const productUrl = handle
        ? new URL(
            `${normalizedProductPathPrefix.replace(/\/+$/, "")}/${handle.replace(/^\//, "")}`,
            options.sourceUrl
          ).toString()
        : undefined;

      const variant = pickVariant(p);
      const price = coercePrice(variant?.price);
      const currencyForProduct = price !== undefined ? currency : undefined;

      products.push({
        sourceSlug: options.sourceSlug,
        itemId,
        name,
        url: productUrl,
        price,
        currency: currencyForProduct,
        imageUrl: pickImageUrl(options.sourceUrl, p)
      });
    }

    page += 1;
  }

  return { products };
}
