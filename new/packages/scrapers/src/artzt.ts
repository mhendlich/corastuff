import { load } from "cheerio";
import type { DiscoveredProduct } from "@corastuff/shared";

function asNonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function coerceOffer(value: unknown): Record<string, unknown> | undefined {
  if (typeof value === "object" && value !== null && !Array.isArray(value)) return value as Record<string, unknown>;
  if (Array.isArray(value) && value.length > 0) {
    const first = value[0];
    if (typeof first === "object" && first !== null && !Array.isArray(first)) return first as Record<string, unknown>;
  }
  return undefined;
}

function pickImageUrl(value: unknown): string | undefined {
  const direct = asNonEmptyString(value);
  if (direct) return direct;
  if (Array.isArray(value) && value.length > 0) {
    const first = value[0];
    const s = asNonEmptyString(first);
    if (s) return s;
  }
  return undefined;
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

function extractVariantId(url: string | undefined): string | undefined {
  const raw = asNonEmptyString(url);
  if (!raw) return undefined;

  try {
    const u = new URL(raw, "https://example.invalid/");
    const v = asNonEmptyString(u.searchParams.get("variant") ?? undefined);
    if (v && /^\d{6,}$/.test(v)) return v;
  } catch {
    // ignore
  }

  const match = raw.match(/[?&]variant=(\d{6,})/);
  if (match?.[1]) return match[1];
  return undefined;
}

function extractItemId(product: Record<string, unknown>, url: string | undefined): string | undefined {
  for (const key of ["sku", "gtin", "gtin13", "mpn"]) {
    const v = asNonEmptyString(product[key]);
    if (v) return v;
  }

  const offers = coerceOffer(product.offers);
  const offerUrl = asNonEmptyString(offers?.url);
  const fromOffer = extractVariantId(offerUrl);
  if (fromOffer) return fromOffer;

  return extractVariantId(url);
}

function findProductJsonLd(html: string): Record<string, unknown> | undefined {
  const $ = load(html);
  const scripts = $('script[type="application/ld+json"]');
  for (const el of scripts.toArray()) {
    const raw = $(el).text().trim();
    if (!raw) continue;
    try {
      const parsed: unknown = JSON.parse(raw);
      const candidates: unknown[] =
        typeof parsed === "object" && parsed !== null
          ? Array.isArray(parsed)
            ? parsed
            : [parsed]
          : [];
      for (const candidate of candidates) {
        if (typeof candidate !== "object" || candidate === null || Array.isArray(candidate)) continue;
        const obj = candidate as Record<string, unknown>;
        if (asNonEmptyString(obj["@type"]) !== "Product") continue;
        if (asNonEmptyString(obj.name) || obj.offers) return obj;
      }
    } catch {
      // ignore
    }
  }
  return undefined;
}

export async function scrapeArtztProductPage(options: {
  sourceSlug: string;
  productUrl: string;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  headers?: Record<string, string>;
  log?: (message: string) => void;
}): Promise<{ products: DiscoveredProduct[] }> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const baseUrl = options.baseUrl ?? "https://artzt.eu/";
  const headers: Record<string, string> = {
    "user-agent":
      "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
    accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "accept-language": "en-US,en;q=0.9,de-DE;q=0.8,de;q=0.7",
    ...options.headers
  };

  options.log?.(`Loading ${options.productUrl}`);
  const resp = await fetchImpl(options.productUrl, { redirect: "follow", headers });
  if (!resp.ok) {
    throw new Error(`ARTZT fetch failed: ${resp.status} ${resp.statusText}`);
  }
  const html = await resp.text();
  const $ = load(html);

  const productJson = findProductJsonLd(html);

  let name =
    asNonEmptyString(productJson?.name) ??
    asNonEmptyString($('meta[property="og:title"]').attr("content")) ??
    undefined;

  let url: string =
    (() => {
      const offers = productJson ? coerceOffer(productJson.offers) : undefined;
      const offerUrl = asNonEmptyString(offers?.url);
      if (offerUrl) return offerUrl;
      return asNonEmptyString(productJson?.url);
    })() ??
    asNonEmptyString($('link[rel="canonical"]').attr("href")) ??
    options.productUrl;

  url = normalizeUrl(baseUrl, url) ?? url;

  const offers = productJson ? coerceOffer(productJson.offers) : undefined;
  const price = coercePrice(offers?.price) ?? coercePrice($('meta[property="product:price:amount"]').attr("content"));
  const currency =
    asNonEmptyString(offers?.priceCurrency) ??
    asNonEmptyString($('meta[property="product:price:currency"]').attr("content")) ??
    undefined;

  let imageUrl =
    (productJson ? pickImageUrl(productJson.image) : undefined) ??
    asNonEmptyString($('meta[property="og:image:secure_url"]').attr("content")) ??
    asNonEmptyString($('meta[property="og:image"]').attr("content")) ??
    undefined;
  imageUrl = normalizeUrl(baseUrl, imageUrl);

  const itemId = productJson ? extractItemId(productJson, url) : extractVariantId(url);

  name = asNonEmptyString(name);
  if (!name || !url) return { products: [] };

  return {
    products: [
      {
        sourceSlug: options.sourceSlug,
        itemId,
        name,
        url,
        price,
        currency: price !== undefined ? currency : undefined,
        imageUrl
      }
    ]
  };
}
