import type { DiscoveredProduct } from "@corastuff/shared";

function asNonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function normalizeSpaces(value: string) {
  return value.replace(/\s+/g, " ").trim();
}

function parseEuroPriceText(text: string | undefined): { price?: number; currency?: string } {
  const raw = asNonEmptyString(text);
  if (!raw) return {};

  const cleaned = raw.replace(/[^\d,.\-]/g, " ").replace(/\s+/g, " ").trim();
  const match = cleaned.match(/-?\d{1,10}(?:[.,]\d{1,2})?/);
  if (!match) return { currency: "EUR" };

  const token = match[0]!;
  const hasComma = token.includes(",");
  const hasDot = token.includes(".");
  const normalized =
    hasComma && hasDot ? token.replace(/\./g, "").replace(",", ".") : hasComma ? token.replace(",", ".") : token;
  const num = Number.parseFloat(normalized);
  if (!Number.isFinite(num) || num <= 0) return { currency: "EUR" };
  return { price: num, currency: "EUR" };
}

const PRODUCT_LINK_RE = /\]\(https:\/\/www\.bike24\.com\/p(?<id>\d+)\.html\s+\"(?<title>[^\"]+)\"\)/g;
const IMAGE_URL_RE = /(https:\/\/images\.bike24\.com\/[^\s)]+)/g;
const PRICE_RE = /(?:from\s+)?[\d][\d\s.,]*\s*€/gi;

export async function scrapeBike24BrandListing(options: {
  sourceSlug: string;
  listingUrl: string;
  log?: (message: string) => void;
  fetchImpl?: typeof fetch;
}): Promise<{ products: DiscoveredProduct[] }> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const headers: Record<string, string> = {
    "user-agent":
      "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
    accept: "text/plain",
    "accept-language": "en-US,en;q=0.9,de-DE;q=0.8,de;q=0.7"
  };

  const jinaUrl = `https://r.jina.ai/${options.listingUrl}`;
  options.log?.(`Loading ${jinaUrl}`);
  const resp = await fetchImpl(jinaUrl, { redirect: "follow", headers });
  if (!resp.ok) {
    throw new Error(`Bike24 listing fetch failed via r.jina.ai: ${resp.status} ${resp.statusText}`);
  }

  const markdown = await resp.text();

  const products: DiscoveredProduct[] = [];
  const seenIds = new Set<string>();

  for (const match of markdown.matchAll(PRODUCT_LINK_RE)) {
    const itemId = asNonEmptyString(match.groups?.id);
    if (!itemId || seenIds.has(itemId)) continue;
    seenIds.add(itemId);

    const name = normalizeSpaces(match.groups?.title ?? "");
    if (!name) continue;

    const url = `https://www.bike24.com/p${itemId}.html`;

    const idx = typeof match.index === "number" ? match.index : 0;
    const ctx = markdown.slice(Math.max(0, idx - 900), idx);

    const imageMatches = Array.from(ctx.matchAll(IMAGE_URL_RE));
    const imageUrl = asNonEmptyString(imageMatches.at(-1)?.[1]);

    const priceMatches = Array.from(ctx.matchAll(PRICE_RE));
    const priceText = asNonEmptyString(priceMatches.at(-1)?.[0]);
    const { price, currency } = parseEuroPriceText(priceText);

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

  return { products };
}

