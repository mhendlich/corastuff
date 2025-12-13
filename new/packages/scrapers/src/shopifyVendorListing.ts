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

function coercePrice(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) return value;
  if (typeof value === "string") {
    const parsed = Number.parseFloat(value);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
  }
  return undefined;
}

function bestPrice(product: ShopifyProduct): number | undefined {
  const variants = product.variants;
  if (!Array.isArray(variants) || variants.length === 0) return undefined;
  let best: number | undefined;
  for (const v of variants) {
    if (typeof v !== "object" || v === null) continue;
    const p = coercePrice(v.price);
    if (p === undefined) continue;
    best = best === undefined ? p : Math.min(best, p);
  }
  return best;
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

function extractProductHandlesFromHtml(html: string): string[] {
  const handles: string[] = [];
  const seen = new Set<string>();
  const re = /\/products\/([a-zA-Z0-9][a-zA-Z0-9-]*)/g;
  for (const match of html.matchAll(re)) {
    const handle = match[1]?.trim();
    if (!handle) continue;
    const key = handle.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    handles.push(handle);
  }
  return handles;
}

async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  fn: (item: T) => Promise<R>
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const runners = Array.from({ length: Math.max(1, concurrency) }, async () => {
    while (true) {
      const idx = next;
      next += 1;
      if (idx >= items.length) break;
      results[idx] = await fn(items[idx]);
    }
  });
  await Promise.all(runners);
  return results;
}

export async function scrapeShopifyVendorListingProducts(options: {
  sourceSlug: string;
  sourceUrl: string;
  vendorListingUrl: string;
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
  const normalizedNoTrailing = normalizedProductPathPrefix.replace(/\/+$/, "");

  options.log?.(`Loading vendor listing ${options.vendorListingUrl}`);
  const listingResp = await fetchImpl(options.vendorListingUrl, {
    redirect: "follow",
    headers: {
      ...headers,
      accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8"
    }
  });
  if (!listingResp.ok) {
    throw new Error(`Shopify vendor listing fetch failed: ${listingResp.status} ${listingResp.statusText}`);
  }
  const html = await listingResp.text();
  const handles = extractProductHandlesFromHtml(html);
  options.log?.(`Found ${handles.length} product handles in vendor listing`);
  if (handles.length === 0) return { products: [] };

  const perHandle = await mapWithConcurrency<string, DiscoveredProduct | null>(handles, 8, async (handle) => {
    const productJsonUrl = new URL(`${normalizedNoTrailing}/${handle}.json`, options.sourceUrl).toString();
    const productUrl = new URL(`${normalizedNoTrailing}/${handle}`, options.sourceUrl).toString();

    const resp = await fetchImpl(productJsonUrl, {
      redirect: "follow",
      headers: {
        ...headers,
        accept: "application/json,text/plain,*/*",
        referer: options.vendorListingUrl
      }
    });
    if (!resp.ok) return null;
    const payload: unknown = await resp.json();
    const product = (payload as { product?: unknown }).product;
    if (typeof product !== "object" || product === null) return null;
    const p = product as ShopifyProduct;

    const name = asNonEmptyString(p.title);
    if (!name) return null;

    const itemId = p.id !== undefined ? String(p.id) : asNonEmptyString(p.handle) ?? handle;
    const price = bestPrice(p);

    const discovered: DiscoveredProduct = {
      sourceSlug: options.sourceSlug,
      itemId,
      name,
      url: productUrl,
      price,
      currency: price !== undefined ? currency : undefined,
      imageUrl: pickImageUrl(options.sourceUrl, p)
    };
    return discovered;
  });

  const products = perHandle.filter((p): p is DiscoveredProduct => p !== null);
  return { products };
}
