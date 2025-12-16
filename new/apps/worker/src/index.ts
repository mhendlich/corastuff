import { Worker } from "bullmq";
import { Redis } from "ioredis";
import { appendFile, mkdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { ConvexHttpClient } from "convex/browser";
import { makeFunctionReference } from "convex/server";
import {
  AUTOMATION_PAUSED_KEY,
  SCRAPE_QUEUE_NAME,
  RUN_SCRAPER_JOB_NAME,
  getRunScraperScheduler,
  type RunScraperJobData
} from "@corastuff/queue";
import {
  scrapeAmazonStorefront,
  scrapeArtztProductPage,
  scrapeBergzeitBrandListing,
  scrapeBike24BrandListing,
  scrapeBunertProductPage,
  scrapeDecathlonChBrandPage,
  scrapeGlobetrotterBrandPage,
  scrapeShopifyCollectionProductsJson,
  scrapeShopifyVendorListingProducts,
  type PlaywrightContextProfile,
  type PlaywrightRunArtifactsOptions
} from "@corastuff/scrapers";
import type { RunStatus, ScrapeResult, StoredImage } from "@corastuff/shared";

const redisUrl = process.env.REDIS_URL ?? "redis://localhost:6379";
const dataDir = process.env.DATA_DIR ?? "/data";
const convexUrl = process.env.CONVEX_URL;
const defaultUserAgent =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

const authLogin = makeFunctionReference<
  "action",
  { password: string; kind?: "user" | "service"; label?: string; ttlMs?: number },
  { ok: boolean; sessionToken: string; kind: "user" | "service"; label: string | null; expiresAt: number }
>("authActions:login");

const settingsGetScraperConcurrencyLimit = makeFunctionReference<
  "query",
  { sessionToken: string },
  number
>("settings:getScraperConcurrencyLimit");

const sourcesGetBySlug = makeFunctionReference<
  "query",
  { sessionToken: string; slug: string },
  { slug: string; enabled?: boolean; config: unknown } | null
>("sources:getBySlug");

const runsCreate = makeFunctionReference<
  "mutation",
  { sessionToken: string; sourceSlug: string; requestedBy?: string },
  { runId: string }
>("runs:create");

const runsSetStatus = makeFunctionReference<
  "mutation",
  { sessionToken: string; runId: string; status: RunStatus; productsFound?: number; missingItemIds?: number; error?: string },
  { ok: boolean }
>("runs:setStatus");

const runsAppendEvent = makeFunctionReference<
  "mutation",
  {
    sessionToken: string;
    runId: string;
    level: "debug" | "info" | "warn" | "error";
    type: "log" | "progress" | "metric" | "checkpoint";
    payload: unknown;
  },
  { id: string }
>("runs:appendEvent");

const runsSetJob = makeFunctionReference<
  "mutation",
  { sessionToken: string; runId: string; job: unknown },
  { ok: boolean }
>("runs:setJob");

const runArtifactsUpsertMany = makeFunctionReference<
  "mutation",
  {
    sessionToken: string;
    runId: string;
    artifacts: Array<{
      key: string;
      type: "log" | "json" | "html" | "screenshot" | "other";
      path: string;
    }>;
  },
  { ok: boolean; created: number; updated: number }
>("runArtifacts:upsertMany");

const runsGet = makeFunctionReference<
  "query",
  { sessionToken: string; runId: string },
  { cancelRequested?: boolean | undefined; status?: RunStatus | undefined } | null
>("runs:get");

const productsIngestRun = makeFunctionReference<
  "mutation",
  {
    sessionToken: string;
    runId: string;
    sourceSlug: string;
    scrapedAt?: number;
    products: Array<{
      itemId: string;
      name: string;
      url?: string;
      price?: number;
      currency?: string;
      image?: StoredImage;
    }>;
  },
  { ok: boolean; inserted: number; updated: number; pricePoints: number }
>("products:ingestRun");

const schedulesSetNextRunAt = makeFunctionReference<
  "mutation",
  { sessionToken: string; sourceSlug: string; nextRunAt: number },
  { ok: boolean; updated: boolean }
>("schedules:setNextRunAt");

class CancelledError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CancelledError";
  }
}

async function ensureDataDirs() {
  await mkdir(`${dataDir}/images`, { recursive: true });
  await mkdir(`${dataDir}/runs`, { recursive: true });
  await mkdir(`${dataDir}/tmp`, { recursive: true });
}

function safeFileId(raw: string) {
  const cleaned = raw.replace(/[^a-zA-Z0-9_-]/g, "_");
  return cleaned.length > 0 ? cleaned : randomUUID();
}

function normalizeSpaces(value: string) {
  return value.replace(/\s+/g, " ").trim();
}

function looksLikeCurrencyCode(value: string | undefined): value is string {
  const s = asNonEmptyString(value);
  return !!s && /^[A-Za-z]{3}$/.test(s);
}

function inferCurrencyFromUrl(url: string | undefined): "CHF" | "EUR" | undefined {
  if (!url) return undefined;
  try {
    const host = new URL(url).hostname.toLowerCase();
    if (host.endsWith(".ch")) return "CHF";
    if (
      host.endsWith(".de") ||
      host.endsWith(".at") ||
      host.endsWith(".eu") ||
      host.endsWith(".fr") ||
      host.endsWith(".it") ||
      host.endsWith(".es") ||
      host.endsWith(".nl")
    ) {
      return "EUR";
    }
  } catch {
    // ignore
  }
  return undefined;
}

function normalizeMaybeUrl(baseUrl: string | undefined, value: string | undefined): string | undefined {
  const raw = asNonEmptyString(value);
  if (!raw) return undefined;
  if (!baseUrl) return raw;
  try {
    if (raw.startsWith("//")) return `https:${raw}`;
    if (raw.startsWith("/")) return new URL(raw, baseUrl).toString();
    return new URL(raw, baseUrl).toString();
  } catch {
    return raw;
  }
}

function extractConfigCurrency(config: unknown): string | undefined {
  if (!isPlainObject(config)) return undefined;
  const raw = asNonEmptyString(config.currency);
  return looksLikeCurrencyCode(raw) ? raw.toUpperCase() : undefined;
}

function extractConfigBaseUrl(config: unknown, fallbackSourceUrl: string): string {
  if (isPlainObject(config)) {
    const raw = asNonEmptyString(config.baseUrl);
    if (raw) return raw;
  }
  try {
    return new URL(fallbackSourceUrl).origin;
  } catch {
    return "https://example.invalid/";
  }
}

async function logToFile(logPath: string, level: string, message: string, payload?: unknown) {
  const ts = new Date().toISOString();
  const suffix = payload === undefined ? "" : ` ${JSON.stringify(payload)}`;
  await appendFile(logPath, `${ts} [${level}] ${message}${suffix}\n`, "utf8");
}

function mimeToExt(mime: string) {
  const m = mime.toLowerCase();
  if (m === "image/jpeg") return "jpg";
  if (m === "image/png") return "png";
  if (m === "image/webp") return "webp";
  if (m === "image/avif") return "avif";
  if (m === "image/gif") return "gif";
  if (m === "image/svg+xml") return "svg";
  return undefined;
}

function urlExt(url: string) {
  try {
    const u = new URL(url);
    const ext = path.extname(u.pathname).replace(".", "").toLowerCase();
    return ext || undefined;
  } catch {
    return undefined;
  }
}

function acceptLanguageForLocale(locale: string | undefined) {
  const raw = asNonEmptyString(locale)?.replace("_", "-");
  if (!raw) return "en-US,en;q=0.9";
  const base = raw.split("-", 1)[0] ?? raw;
  if (base.toLowerCase() === raw.toLowerCase()) return `${raw},en-US;q=0.9,en;q=0.8`;
  return `${raw},${base};q=0.9,en-US;q=0.8,en;q=0.7`;
}

function registrableDomain(hostname: string) {
  const parts = hostname.split(".").filter(Boolean);
  if (parts.length <= 2) return hostname.toLowerCase();
  const last = parts[parts.length - 1]!;
  const secondLast = parts[parts.length - 2]!;
  const thirdLast = parts[parts.length - 3];
  const twoLevel = new Set(["co", "com", "org", "net", "gov", "ac"]);
  if (thirdLast && last === "uk" && twoLevel.has(secondLast)) {
    return `${thirdLast}.${secondLast}.${last}`.toLowerCase();
  }
  return `${secondLast}.${last}`.toLowerCase();
}

function secFetchSite(referer: string, target: string): "same-origin" | "same-site" | "cross-site" | undefined {
  try {
    const r = new URL(referer);
    const t = new URL(target);
    if (r.origin === t.origin) return "same-origin";
    if (registrableDomain(r.hostname) === registrableDomain(t.hostname)) return "same-site";
    return "cross-site";
  } catch {
    return undefined;
  }
}

async function downloadAndStoreImage(options: {
  imageUrl: string;
  referer: string;
  imagesDir: string;
  userAgent?: string;
  acceptLanguage?: string;
}): Promise<StoredImage | undefined> {
  const userAgent = asNonEmptyString(options.userAgent) ?? defaultUserAgent;
  const acceptLanguage = asNonEmptyString(options.acceptLanguage) ?? "en-US,en;q=0.9";
  const fetchSite = secFetchSite(options.referer, options.imageUrl) ?? "cross-site";

  const resp = await fetch(options.imageUrl, {
    redirect: "follow",
    headers: {
      Accept: "image/avif,image/webp,image/apng,image/*,*/*;q=0.8",
      "Accept-Language": acceptLanguage,
      Referer: options.referer,
      "User-Agent": userAgent,
      DNT: "1",
      "Sec-Fetch-Dest": "image",
      "Sec-Fetch-Mode": "no-cors",
      "Sec-Fetch-Site": fetchSite,
      "Sec-CH-UA": "\"Chromium\";v=\"131\", \"Not_A Brand\";v=\"24\", \"Google Chrome\";v=\"131\"",
      "Sec-CH-UA-Mobile": "?0",
      "Sec-CH-UA-Platform": "\"Linux\""
    }
  });
  if (!resp.ok) return undefined;
  const mimeRaw = resp.headers.get("content-type") ?? "";
  const mime = mimeRaw.split(";", 1)[0]?.trim() ?? "";
  if (!mime.startsWith("image/")) return undefined;
  const body = new Uint8Array(await resp.arrayBuffer());
  if (body.byteLength < 800) return undefined;

  const hash = createHash("sha256").update(body).digest("hex");
  const ext = mimeToExt(mime) ?? urlExt(options.imageUrl) ?? "bin";
  const filename = `${hash}.${ext}`;
  const fullPath = path.join(options.imagesDir, filename);

  try {
    await writeFile(fullPath, body, { flag: "wx" });
  } catch (err) {
    const code = err instanceof Error ? (err as NodeJS.ErrnoException).code : undefined;
    if (code !== "EEXIST") throw err;
  }

  return {
    hash,
    mime,
    bytes: body.byteLength,
    path: `images/${filename}`,
    mediaUrl: `/media/images/${filename}`
  };
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

function normalizeScrapedProducts(products: ScrapeResult["products"], options: { sourceUrl: string; config: unknown }) {
  const baseUrl = extractConfigBaseUrl(options.config, options.sourceUrl);
  const configCurrency = extractConfigCurrency(options.config);
  const inferredBySourceUrl = inferCurrencyFromUrl(options.sourceUrl);
  const fallbackCurrency = configCurrency ?? inferredBySourceUrl;

  const out: ScrapeResult["products"] = [];
  for (const p of products) {
    const name = normalizeSpaces(p.name ?? "");
    if (!name) continue;

    const itemIdRaw = asNonEmptyString(p.itemId);
    const itemId = itemIdRaw ? itemIdRaw.trim() : undefined;

    const url = normalizeMaybeUrl(baseUrl, asNonEmptyString(p.url));
    const imageUrl = normalizeMaybeUrl(baseUrl, asNonEmptyString(p.imageUrl));

    const price =
      typeof p.price === "number" && Number.isFinite(p.price) && p.price > 0 ? p.price : undefined;

    const currency =
      looksLikeCurrencyCode(p.currency) ? p.currency.toUpperCase() : price !== undefined ? fallbackCurrency : undefined;

    out.push({
      ...p,
      itemId,
      name,
      url,
      imageUrl,
      price,
      currency
    });
  }

  return out;
}

function asNonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parsePlaywrightProfile(cfg: Record<string, unknown>): PlaywrightContextProfile | undefined {
  const nestedCandidate =
    (isPlainObject(cfg.playwright) ? cfg.playwright : undefined) ??
    (isPlainObject(cfg.browserContext) ? cfg.browserContext : undefined) ??
    (isPlainObject(cfg.browser) ? cfg.browser : undefined) ??
    (isPlainObject(cfg.context) ? cfg.context : undefined);

  const pickString = (key: string) => asNonEmptyString((nestedCandidate ?? cfg)[key]) ?? asNonEmptyString(cfg[key]);
  const pickBool = (key: string) => {
    const v = (nestedCandidate ?? cfg)[key] ?? cfg[key];
    return typeof v === "boolean" ? v : undefined;
  };

  const browserTypeRaw = pickString("browserType") ?? pickString("browser_type");
  const browserType =
    browserTypeRaw === "chromium" || browserTypeRaw === "firefox" || browserTypeRaw === "webkit"
      ? browserTypeRaw
      : undefined;

  const userAgent = pickString("userAgent") ?? pickString("user_agent");
  const locale = pickString("locale");
  const stealth = pickBool("stealth") ?? pickBool("stealthInit") ?? pickBool("stealth_init");

  const viewportRaw = (nestedCandidate ?? cfg).viewport ?? cfg.viewport;
  const viewport =
    isPlainObject(viewportRaw) &&
    typeof viewportRaw.width === "number" &&
    Number.isFinite(viewportRaw.width) &&
    typeof viewportRaw.height === "number" &&
    Number.isFinite(viewportRaw.height)
      ? { width: Math.trunc(viewportRaw.width), height: Math.trunc(viewportRaw.height) }
      : (() => {
          const w = (nestedCandidate ?? cfg).viewportWidth ?? cfg.viewportWidth ?? (nestedCandidate ?? cfg).viewport_width ?? cfg.viewport_width;
          const h = (nestedCandidate ?? cfg).viewportHeight ?? cfg.viewportHeight ?? (nestedCandidate ?? cfg).viewport_height ?? cfg.viewport_height;
          const width = typeof w === "number" && Number.isFinite(w) ? Math.trunc(w) : undefined;
          const height = typeof h === "number" && Number.isFinite(h) ? Math.trunc(h) : undefined;
          if (!width || !height) return undefined;
          return { width, height };
        })();

  const initScriptsRaw = (nestedCandidate ?? cfg).initScripts ?? cfg.initScripts;
  const initScripts =
    typeof initScriptsRaw === "string"
      ? [initScriptsRaw]
      : Array.isArray(initScriptsRaw)
        ? initScriptsRaw.filter((s): s is string => typeof s === "string" && s.trim().length > 0)
        : undefined;

  const headless = pickBool("headless");
  const slowMoRaw =
    (nestedCandidate ?? cfg).slowMoMs ??
    cfg.slowMoMs ??
    (nestedCandidate ?? cfg).slow_mo_ms ??
    cfg.slow_mo_ms ??
    (nestedCandidate ?? cfg).slowMo ??
    cfg.slowMo;
  const slowMoMs =
    typeof slowMoRaw === "number" && Number.isFinite(slowMoRaw) && slowMoRaw > 0 ? Math.trunc(slowMoRaw) : undefined;

  const profile: PlaywrightContextProfile = {
    ...(browserType ? { browserType } : {}),
    ...(userAgent ? { userAgent } : {}),
    ...(locale ? { locale } : {}),
    ...(viewport ? { viewport } : {}),
    ...(stealth !== undefined ? { stealth } : {}),
    ...(initScripts ? { initScripts } : {}),
    ...(headless !== undefined ? { headless } : {}),
    ...(slowMoMs !== undefined ? { slowMoMs } : {})
  };

  return Object.keys(profile).length > 0 ? profile : undefined;
}

function parseAmazonStorefrontConfig(
  sourceSlug: string,
  config: unknown
): {
  sourceSlug: string;
  storeUrl: string;
  baseUrl: string;
  currency?: string;
  browser?: PlaywrightContextProfile;
} | null {
  if (typeof config !== "object" || config === null || Array.isArray(config)) return null;
  const cfg = config as Record<string, unknown>;

  const storeUrl =
    asNonEmptyString(cfg.amazonStoreUrl) ??
    asNonEmptyString(cfg.storeUrl) ??
    asNonEmptyString(cfg.storefrontUrl) ??
    asNonEmptyString(cfg.sourceUrl);
  if (!storeUrl) return null;

  let u: URL;
  try {
    u = new URL(storeUrl);
  } catch {
    return null;
  }
  if (!u.hostname.toLowerCase().includes("amazon.")) return null;

  const baseUrl = asNonEmptyString(cfg.baseUrl) ?? u.origin;
  const currency = asNonEmptyString(cfg.currency);
  const browser = parsePlaywrightProfile(cfg);
  return { sourceSlug, storeUrl, baseUrl, ...(currency ? { currency } : {}), ...(browser ? { browser } : {}) };
}

function parseShopifyCollectionConfig(
  sourceSlug: string,
  config: unknown
): {
  sourceSlug: string;
  sourceUrl: string;
  collectionProductsJsonUrl: string;
  productPathPrefix?: string;
  constraint?: string;
  currency?: string;
} | null {
  if (typeof config !== "object" || config === null || Array.isArray(config)) return null;
  const cfg = config as Record<string, unknown>;

  const collectionProductsJsonUrl = asNonEmptyString(cfg.collectionProductsJsonUrl);
  if (!collectionProductsJsonUrl) return null;

  const currency = asNonEmptyString(cfg.currency);
  const productPathPrefix = asNonEmptyString(cfg.productPathPrefix);
  const constraint = asNonEmptyString(cfg.constraint);
  const baseUrl = asNonEmptyString(cfg.baseUrl);
  const sourceUrl =
    asNonEmptyString(cfg.sourceUrl) ??
    baseUrl ??
    (() => {
      try {
        return new URL(collectionProductsJsonUrl).origin;
      } catch {
        return "";
      }
    })();

  if (!sourceUrl) {
    throw new Error(`Invalid config for ${sourceSlug}: missing baseUrl/sourceUrl`);
  }

  return {
    sourceSlug,
    sourceUrl,
    collectionProductsJsonUrl,
    ...(productPathPrefix ? { productPathPrefix } : {}),
    ...(constraint ? { constraint } : {}),
    ...(currency ? { currency } : {})
  };
}

function parseShopifyVendorListingConfig(
  sourceSlug: string,
  config: unknown
): {
  sourceSlug: string;
  sourceUrl: string;
  vendorListingUrl: string;
  productPathPrefix?: string;
  currency?: string;
} | null {
  if (typeof config !== "object" || config === null || Array.isArray(config)) return null;
  const cfg = config as Record<string, unknown>;

  const vendorListingUrl = asNonEmptyString(cfg.vendorListingUrl) ?? asNonEmptyString(cfg.sourceUrl);
  if (!vendorListingUrl) return null;

  const currency = asNonEmptyString(cfg.currency);
  const productPathPrefix = asNonEmptyString(cfg.productPathPrefix);
  const baseUrl = asNonEmptyString(cfg.baseUrl);
  const sourceUrl =
    asNonEmptyString(cfg.sourceUrl) ??
    baseUrl ??
    (() => {
      try {
        return new URL(vendorListingUrl).origin;
      } catch {
        return "";
      }
    })();

  if (!sourceUrl) {
    throw new Error(`Invalid config for ${sourceSlug}: missing baseUrl/sourceUrl`);
  }

  return {
    sourceSlug,
    sourceUrl,
    vendorListingUrl,
    ...(productPathPrefix ? { productPathPrefix } : {}),
    ...(currency ? { currency } : {})
  };
}

function parseGlobetrotterBrandConfig(
  sourceSlug: string,
  config: unknown
): {
  sourceSlug: string;
  baseUrl: string;
  listingUrl: string;
  currency?: string;
  browser?: PlaywrightContextProfile;
} | null {
  if (typeof config !== "object" || config === null || Array.isArray(config)) return null;
  const cfg = config as Record<string, unknown>;

  const listingUrl = asNonEmptyString(cfg.listingUrl) ?? asNonEmptyString(cfg.sourceUrl);
  if (!listingUrl) return null;

  try {
    const u = new URL(listingUrl);
    const host = u.hostname.toLowerCase();
    if (!host.includes("globetrotter.") && !host.endsWith("globetrotter.de")) return null;
  } catch {
    return null;
  }

  const baseUrl =
    asNonEmptyString(cfg.baseUrl) ??
    (() => {
      try {
        return new URL(listingUrl).origin;
      } catch {
        return "";
      }
    })();
  if (!baseUrl) return null;

  const currency = asNonEmptyString(cfg.currency);
  const browser = parsePlaywrightProfile(cfg);
  return { sourceSlug, baseUrl, listingUrl, ...(currency ? { currency } : {}), ...(browser ? { browser } : {}) };
}

function parseArtztProductConfig(
  sourceSlug: string,
  config: unknown
): {
  sourceSlug: string;
  productUrl: string;
  baseUrl?: string;
} | null {
  if (typeof config !== "object" || config === null || Array.isArray(config)) return null;
  const cfg = config as Record<string, unknown>;

  const productUrl = asNonEmptyString(cfg.productUrl) ?? asNonEmptyString(cfg.sourceUrl) ?? asNonEmptyString(cfg.url);
  if (!productUrl) return null;

  try {
    const u = new URL(productUrl);
    const host = u.hostname.toLowerCase();
    if (!host.includes("artzt.") && !host.endsWith("artzt.eu")) return null;
  } catch {
    return null;
  }

  const baseUrl = asNonEmptyString(cfg.baseUrl);
  return { sourceSlug, productUrl, ...(baseUrl ? { baseUrl } : {}) };
}

function parseBunertProductConfig(
  sourceSlug: string,
  config: unknown
): {
  sourceSlug: string;
  productUrl: string;
  currency?: string;
  browser?: PlaywrightContextProfile;
} | null {
  if (typeof config !== "object" || config === null || Array.isArray(config)) return null;
  const cfg = config as Record<string, unknown>;

  const productUrl = asNonEmptyString(cfg.productUrl) ?? asNonEmptyString(cfg.sourceUrl) ?? asNonEmptyString(cfg.url);
  if (!productUrl) return null;

  try {
    const u = new URL(productUrl);
    const host = u.hostname.toLowerCase();
    if (!host.includes("bunert.") && !host.endsWith("bunert.de")) return null;
  } catch {
    return null;
  }

  const currency = asNonEmptyString(cfg.currency);
  const browser = parsePlaywrightProfile(cfg);
  return { sourceSlug, productUrl, ...(currency ? { currency } : {}), ...(browser ? { browser } : {}) };
}

function parseBergzeitBrandConfig(
  sourceSlug: string,
  config: unknown
): {
  sourceSlug: string;
  listingUrl: string;
  baseUrl?: string;
  browser?: PlaywrightContextProfile;
} | null {
  if (typeof config !== "object" || config === null || Array.isArray(config)) return null;
  const cfg = config as Record<string, unknown>;

  const listingUrl = asNonEmptyString(cfg.listingUrl) ?? asNonEmptyString(cfg.sourceUrl) ?? asNonEmptyString(cfg.url);
  if (!listingUrl) return null;

  try {
    const u = new URL(listingUrl);
    const host = u.hostname.toLowerCase();
    if (!host.includes("bergzeit.") && !host.endsWith("bergzeit.de")) return null;
  } catch {
    return null;
  }

  const baseUrl = asNonEmptyString(cfg.baseUrl);
  const browser = parsePlaywrightProfile(cfg);
  return { sourceSlug, listingUrl, ...(baseUrl ? { baseUrl } : {}), ...(browser ? { browser } : {}) };
}

function parseBike24BrandConfig(
  sourceSlug: string,
  config: unknown
): {
  sourceSlug: string;
  listingUrl: string;
} | null {
  if (typeof config !== "object" || config === null || Array.isArray(config)) return null;
  const cfg = config as Record<string, unknown>;

  const listingUrl = asNonEmptyString(cfg.listingUrl) ?? asNonEmptyString(cfg.sourceUrl) ?? asNonEmptyString(cfg.url);
  if (!listingUrl) return null;

  try {
    const u = new URL(listingUrl);
    const host = u.hostname.toLowerCase();
    if (!host.endsWith("bike24.com")) return null;
  } catch {
    return null;
  }

  return { sourceSlug, listingUrl };
}

function parseDecathlonChBrandConfig(
  sourceSlug: string,
  config: unknown
): {
  sourceSlug: string;
  listingUrl: string;
  baseUrl?: string;
  currency?: string;
  browser?: PlaywrightContextProfile;
} | null {
  if (typeof config !== "object" || config === null || Array.isArray(config)) return null;
  const cfg = config as Record<string, unknown>;

  const listingUrl = asNonEmptyString(cfg.listingUrl) ?? asNonEmptyString(cfg.sourceUrl) ?? asNonEmptyString(cfg.url);
  if (!listingUrl) return null;

  try {
    const u = new URL(listingUrl);
    const host = u.hostname.toLowerCase();
    if (!host.endsWith("decathlon.ch")) return null;
  } catch {
    return null;
  }

  const baseUrl = asNonEmptyString(cfg.baseUrl);
  const currency = asNonEmptyString(cfg.currency);
  const browser = parsePlaywrightProfile(cfg);
  return {
    sourceSlug,
    listingUrl,
    ...(baseUrl ? { baseUrl } : {}),
    ...(currency ? { currency } : {}),
    ...(browser ? { browser } : {})
  };
}

const FALLBACK_SOURCE_CONFIGS: Record<string, Record<string, unknown>> = {
  amazon_de: {
    storeUrl:
      "https://www.amazon.de/stores/page/03098AB4-BDD5-4A23-A7DD-5C10153C5D58?ingress=2&lp_context_asin=B00EQ4PZHY&lp_context_query=blackroll&store_ref=bl_ast_dp_brandLogo_sto&ref_=ast_bln",
    currency: "EUR"
  },
  cardiofitness: {
    baseUrl: "https://www.cardiofitness.de/",
    sourceUrl: "https://www.cardiofitness.de/collections/blackroll",
    collectionProductsJsonUrl: "https://www.cardiofitness.de/collections/blackroll/products.json",
    currency: "EUR"
  },
  medidor: {
    baseUrl: "https://medidor.ch/",
    sourceUrl: "https://medidor.ch/en/collections/vendors?q=blackroll",
    vendorListingUrl: "https://medidor.ch/en/collections/vendors?q=blackroll",
    productPathPrefix: "/en/products/",
    currency: "CHF"
  },
  globetrotter: {
    baseUrl: "https://www.globetrotter.de/",
    listingUrl: "https://www.globetrotter.de/marken/blackroll/",
    currency: "EUR"
  },
  bergzeit: {
    baseUrl: "https://www.bergzeit.de/",
    listingUrl: "https://www.bergzeit.de/marken/blackroll/"
  },
  bike24: {
    listingUrl: "https://www.bike24.com/brands/blackroll/category-76"
  },
  decathlon_ch: {
    baseUrl: "https://www.decathlon.ch",
    listingUrl: "https://www.decathlon.ch/de/brands/blackroll",
    currency: "CHF"
  },
  artzt: {
    baseUrl: "https://artzt.eu/",
    productUrl: "https://artzt.eu/en/products/blackroll-standard"
  }
};

async function scrapeSource(args: {
  sourceSlug: string;
  config: unknown;
  log: (msg: string) => void;
  artifacts?: PlaywrightRunArtifactsOptions;
}): Promise<ScrapeResult> {
  const amazon = parseAmazonStorefrontConfig(args.sourceSlug, args.config);
  if (amazon) {
    const { products } = await scrapeAmazonStorefront({
      sourceSlug: amazon.sourceSlug,
      storeUrl: amazon.storeUrl,
      baseUrl: amazon.baseUrl,
      currency: amazon.currency,
      ...(amazon.browser ? { browser: amazon.browser } : {}),
      ...(args.artifacts ? { artifacts: args.artifacts } : {}),
      log: args.log
    });
    return {
      sourceSlug: amazon.sourceSlug,
      sourceUrl: amazon.storeUrl,
      scrapedAt: new Date().toISOString(),
      totalProducts: products.length,
      products
    };
  }

  const artzt = parseArtztProductConfig(args.sourceSlug, args.config);
  if (artzt) {
    const { products } = await scrapeArtztProductPage({
      sourceSlug: artzt.sourceSlug,
      productUrl: artzt.productUrl,
      baseUrl: artzt.baseUrl,
      log: args.log
    });
    return {
      sourceSlug: artzt.sourceSlug,
      sourceUrl: artzt.productUrl,
      scrapedAt: new Date().toISOString(),
      totalProducts: products.length,
      products
    };
  }

  const bunert = parseBunertProductConfig(args.sourceSlug, args.config);
  if (bunert) {
    const { products } = await scrapeBunertProductPage({
      sourceSlug: bunert.sourceSlug,
      productUrl: bunert.productUrl,
      currency: bunert.currency,
      ...(bunert.browser ? { browser: bunert.browser } : {}),
      ...(args.artifacts ? { artifacts: args.artifacts } : {}),
      log: args.log
    });
    return {
      sourceSlug: bunert.sourceSlug,
      sourceUrl: bunert.productUrl,
      scrapedAt: new Date().toISOString(),
      totalProducts: products.length,
      products
    };
  }

  const bergzeit = parseBergzeitBrandConfig(args.sourceSlug, args.config);
  if (bergzeit) {
    const { products } = await scrapeBergzeitBrandListing({
      sourceSlug: bergzeit.sourceSlug,
      listingUrl: bergzeit.listingUrl,
      baseUrl: bergzeit.baseUrl,
      ...(bergzeit.browser ? { browser: bergzeit.browser } : {}),
      ...(args.artifacts ? { artifacts: args.artifacts } : {}),
      log: args.log
    });
    return {
      sourceSlug: bergzeit.sourceSlug,
      sourceUrl: bergzeit.listingUrl,
      scrapedAt: new Date().toISOString(),
      totalProducts: products.length,
      products
    };
  }

  const bike24 = parseBike24BrandConfig(args.sourceSlug, args.config);
  if (bike24) {
    const { products } = await scrapeBike24BrandListing({
      sourceSlug: bike24.sourceSlug,
      listingUrl: bike24.listingUrl,
      log: args.log
    });
    return {
      sourceSlug: bike24.sourceSlug,
      sourceUrl: bike24.listingUrl,
      scrapedAt: new Date().toISOString(),
      totalProducts: products.length,
      products
    };
  }

  const globetrotter = parseGlobetrotterBrandConfig(args.sourceSlug, args.config);
  if (globetrotter) {
    const { products } = await scrapeGlobetrotterBrandPage({
      sourceSlug: globetrotter.sourceSlug,
      listingUrl: globetrotter.listingUrl,
      baseUrl: globetrotter.baseUrl,
      currency: globetrotter.currency,
      ...(globetrotter.browser ? { browser: globetrotter.browser } : {}),
      ...(args.artifacts ? { artifacts: args.artifacts } : {}),
      log: args.log
    });
    return {
      sourceSlug: globetrotter.sourceSlug,
      sourceUrl: globetrotter.listingUrl,
      scrapedAt: new Date().toISOString(),
      totalProducts: products.length,
      products
    };
  }

  const decathlon = parseDecathlonChBrandConfig(args.sourceSlug, args.config);
  if (decathlon) {
    const { products } = await scrapeDecathlonChBrandPage({
      sourceSlug: decathlon.sourceSlug,
      listingUrl: decathlon.listingUrl,
      baseUrl: decathlon.baseUrl,
      currency: decathlon.currency,
      ...(decathlon.browser ? { browser: decathlon.browser } : {}),
      ...(args.artifacts ? { artifacts: args.artifacts } : {}),
      log: args.log
    });
    return {
      sourceSlug: decathlon.sourceSlug,
      sourceUrl: decathlon.listingUrl,
      scrapedAt: new Date().toISOString(),
      totalProducts: products.length,
      products
    };
  }

  const shopify = parseShopifyCollectionConfig(args.sourceSlug, args.config);
  if (shopify) {
    const { products } = await scrapeShopifyCollectionProductsJson({
      sourceSlug: shopify.sourceSlug,
      sourceUrl: shopify.sourceUrl,
      collectionProductsJsonUrl: shopify.collectionProductsJsonUrl,
      productPathPrefix: shopify.productPathPrefix,
      constraint: shopify.constraint,
      currency: shopify.currency,
      log: args.log
    });
    return {
      sourceSlug: shopify.sourceSlug,
      sourceUrl: shopify.sourceUrl,
      scrapedAt: new Date().toISOString(),
      totalProducts: products.length,
      products
    };
  }

  const vendor = parseShopifyVendorListingConfig(args.sourceSlug, args.config);
  if (vendor) {
    const { products } = await scrapeShopifyVendorListingProducts({
      sourceSlug: vendor.sourceSlug,
      sourceUrl: vendor.sourceUrl,
      vendorListingUrl: vendor.vendorListingUrl,
      productPathPrefix: vendor.productPathPrefix,
      currency: vendor.currency,
      log: args.log
    });
    return {
      sourceSlug: vendor.sourceSlug,
      sourceUrl: vendor.sourceUrl,
      scrapedAt: new Date().toISOString(),
      totalProducts: products.length,
      products
    };
  }

  throw new Error(
    `No scraper implemented for sourceSlug "${args.sourceSlug}" (expected storeUrl (Amazon), collectionProductsJsonUrl, vendorListingUrl, or listingUrl in config)`
  );
}

async function main() {
  await ensureDataDirs();

  const connection = new Redis(redisUrl, {
    maxRetriesPerRequest: null
  });

  const workerId = process.env.HOSTNAME ?? "worker";

  let convex: ConvexHttpClient | null = convexUrl ? new ConvexHttpClient(convexUrl) : null;
  let convexSessionToken: string | null = null;
  let concurrencyLimit = Number.parseInt(process.env.SCRAPER_CONCURRENCY_LIMIT ?? "", 10);
  if (!Number.isFinite(concurrencyLimit) || concurrencyLimit < 1) {
    concurrencyLimit = 10;
  }
  if (!convex) {
    console.warn("[worker] CONVEX_URL not set; jobs will run without status updates");
  } else {
    const password = process.env.CORASTUFF_PASSWORD ?? "";
    if (!password) {
      console.warn("[worker] CORASTUFF_PASSWORD not set; running without Convex updates");
      convex = null;
    } else {
      try {
        const result = await convex.action(authLogin, { password, kind: "service", label: `worker:${workerId}` });
        convexSessionToken = result.sessionToken;

        try {
          const limit = await convex.query(settingsGetScraperConcurrencyLimit, { sessionToken: convexSessionToken });
          if (typeof limit === "number" && Number.isFinite(limit) && limit >= 1) {
            concurrencyLimit = Math.min(100, Math.max(1, Math.trunc(limit)));
          }
        } catch (err) {
          console.warn("[worker] failed to fetch concurrency limit; using fallback:", err);
        }
      } catch (err) {
        console.warn("[worker] failed to authenticate to Convex; running without Convex updates:", err);
        convex = null;
      }
    }
  }

  console.log(`[worker] concurrency=${concurrencyLimit}`);

  const worker = new Worker(
    SCRAPE_QUEUE_NAME,
    async (job) => {
      if (job.name !== RUN_SCRAPER_JOB_NAME) {
        return { ok: true, ignored: true, name: job.name };
      }

      const data = job.data as RunScraperJobData;
      const sourceSlug = typeof data?.sourceSlug === "string" ? data.sourceSlug.trim() : "";
      const requestedBy = typeof data?.requestedBy === "string" ? data.requestedBy : undefined;
      const dryRun = data?.dryRun === true;
      const configOverride = data?.configOverride;
      let runId = typeof data?.runId === "string" ? data.runId.trim() : "";
      const wasRunIdMissing = !runId;
      if (!sourceSlug) {
        throw new Error("Invalid job payload: expected { sourceSlug: string }");
      }

      if (wasRunIdMissing && requestedBy === "scheduled") {
        const raw = await connection.get(AUTOMATION_PAUSED_KEY).catch(() => null);
        const paused = raw === "1" || raw === "true";
        if (paused) {
          return { ok: true, skipped: true, reason: "automation_paused" as const, sourceSlug };
        }
      }

      let convexForRun: ConvexHttpClient | null = convex && convexSessionToken ? convex : null;
      const sessionToken = convexSessionToken;
      if (!runId) {
        if (convexForRun) {
          try {
            const created = await convexForRun.mutation(runsCreate, {
              sessionToken: sessionToken!,
              sourceSlug,
              requestedBy: requestedBy ?? "scheduled"
            });
            runId = created.runId;
          } catch (err) {
            console.warn("[worker] failed to create Convex run, falling back to UUID:", err);
            convexForRun = null;
            runId = randomUUID();
          }
        } else {
          runId = randomUUID();
        }
      }

      const runDir = path.join(dataDir, "runs", safeFileId(runId));
      await mkdir(runDir, { recursive: true });
      const logPath = path.join(runDir, "run.log");
      const runDirName = path.basename(runDir);
      const productsJsonAbsPath = path.join(runDir, "products.json");
      const productsJsonPath = `runs/${runDirName}/products.json`;
      const runLogPath = `runs/${runDirName}/run.log`;

      const playwrightArtifacts: Array<{ key: string; type: "html" | "screenshot" | "other"; absPath: string }> = [];
      const enableTraceDryRun = process.env.SCRAPER_TRACE_DRY_RUN !== "0";
      const enableTraceOnError = process.env.SCRAPER_TRACE_ON_ERROR === "1";
      const traceEnabled = dryRun ? enableTraceDryRun : enableTraceOnError;

      const pwArtifacts: PlaywrightRunArtifactsOptions = {
        dir: runDir,
        prefix: sourceSlug,
        when: dryRun ? "always" : "error",
        capture: {
          html: true,
          screenshot: true,
          trace: traceEnabled
        },
        onArtifact: (artifact) => {
          if (!artifact?.absPath || !artifact.key) return;
          const type =
            artifact.type === "html" || artifact.type === "screenshot" || artifact.type === "other"
              ? artifact.type
              : "other";
          playwrightArtifacts.push({ key: artifact.key, type, absPath: artifact.absPath });
        }
      };

      const log = async (level: "debug" | "info" | "warn" | "error", message: string, payload?: unknown) => {
        await logToFile(logPath, level, message, payload);
        if (convexForRun) {
          const extra =
            payload !== undefined && typeof payload === "object" && payload !== null && !Array.isArray(payload)
              ? (payload as Record<string, unknown>)
              : payload !== undefined
                ? { data: payload }
                : {};
          try {
            await convexForRun.mutation(runsAppendEvent, {
              sessionToken: sessionToken!,
              runId,
              level,
              type: "log",
              payload: { message, ...extra }
            });
          } catch (err) {
            convexForRun = null;
            console.warn("[worker] disabling Convex updates for this run due to error:", err);
          }
        }
      };

      const toMediaRelativePath = (absPath: string) => path.relative(dataDir, absPath).split(path.sep).join("/");

      const buildConvexArtifacts = async (includeProductsJson: boolean) => {
        const mapped = playwrightArtifacts
          .map((a) => {
            const rel = toMediaRelativePath(a.absPath);
            if (!rel || rel.startsWith("..")) return null;
            const type = a.type === "html" ? "html" : a.type === "screenshot" ? "screenshot" : "other";
            return { key: a.key, type, path: rel } as const;
          })
          .filter(Boolean) as Array<{ key: string; type: "html" | "screenshot" | "other"; path: string }>;

        const out: Array<{ key: string; type: "log" | "json" | "html" | "screenshot" | "other"; path: string }> = [
          { key: "run.log", type: "log", path: runLogPath },
          ...mapped
        ];

        if (includeProductsJson) {
          const exists = await stat(productsJsonAbsPath).then(() => true).catch(() => false);
          if (exists) out.unshift({ key: "products.json", type: "json", path: productsJsonPath });
        }

        return out;
      };

      const upsertRunArtifacts = async (includeProductsJson: boolean) => {
        if (!convexForRun) return;
        try {
          const artifacts = await buildConvexArtifacts(includeProductsJson);
          await convexForRun.mutation(runArtifactsUpsertMany, {
            sessionToken: sessionToken!,
            runId,
            artifacts
          });
        } catch (err) {
          convexForRun = null;
          console.warn("[worker] disabling Convex updates for this run due to artifact error:", err);
        }
      };

      try {
        if (wasRunIdMissing && convexForRun) {
          try {
            const scheduler = await getRunScraperScheduler(redisUrl, sourceSlug);
            if (typeof scheduler.nextRunAt === "number") {
              await convexForRun.mutation(schedulesSetNextRunAt, {
                sessionToken: sessionToken!,
                sourceSlug,
                nextRunAt: scheduler.nextRunAt
              });
            }
          } catch (err) {
            await log("warn", "Failed to refresh schedule nextRunAt", {
              error: err instanceof Error ? err.message : String(err)
            });
          }
        }

        let sourceConfig: unknown = null;
        let sourceEnabled: boolean | null = null;
        const hasConfigOverride = configOverride !== undefined;
        if (hasConfigOverride) {
          sourceConfig = configOverride;
        } else if (convexForRun) {
          try {
            const sourceDoc = await convexForRun.query(sourcesGetBySlug, {
              sessionToken: sessionToken!,
              slug: sourceSlug
            });
            sourceConfig = sourceDoc?.config ?? null;
            if (typeof sourceDoc?.enabled === "boolean") {
              sourceEnabled = sourceDoc.enabled;
            }
          } catch (err) {
            await log("warn", "Failed to fetch source config from Convex; using fallback config", {
              error: err instanceof Error ? err.message : String(err)
            });
          }
        }
        if (!sourceConfig) {
          sourceConfig = FALLBACK_SOURCE_CONFIGS[sourceSlug] ?? null;
        }

        const cancelRequested = async () => {
          if (!convexForRun) return false;
          try {
            const run = await convexForRun.query(runsGet, { sessionToken: sessionToken!, runId });
            return run?.cancelRequested === true;
          } catch {
            return false;
          }
        };

        const throwIfCancelled = async (phase: string) => {
          if (await cancelRequested()) {
            await log("warn", "Cancel requested; stopping", { phase });
            throw new CancelledError(`Cancelled: ${phase}`);
          }
        };

        if (convexForRun) {
          await convexForRun.mutation(runsSetJob, {
            sessionToken: sessionToken!,
            runId,
            job: {
              queueJobId: job.id ?? null,
              attempt: job.attemptsMade,
              workerId,
              receivedAt: Date.now(),
              ...(dryRun ? { dryRun: true } : {}),
              ...(hasConfigOverride ? { configOverride: true } : {})
            }
          });

          if (!hasConfigOverride && sourceEnabled === false) {
            await convexForRun.mutation(runsSetStatus, { sessionToken: sessionToken!, runId, status: "canceled" });
            await log("warn", "Source disabled; skipping run", { sourceSlug, workerId });
            return { ok: true, status: "canceled" as const, runId, sourceSlug };
          }

          if (await cancelRequested()) {
            await convexForRun.mutation(runsSetStatus, { sessionToken: sessionToken!, runId, status: "canceled" });
            await log("warn", "Run canceled before start", { workerId });
            return { ok: true, status: "canceled" as const, runId, sourceSlug };
          }

          await convexForRun.mutation(runsSetStatus, { sessionToken: sessionToken!, runId, status: "running" });
        }

        await log("info", `Worker started run for ${sourceSlug}`, { workerId });

        await throwIfCancelled("before_scrape");
        let scrapeResult = await scrapeSource({
          sourceSlug,
          config: sourceConfig,
          artifacts: pwArtifacts,
          log: (m) => {
            void log("info", m);
          }
        });
        const normalizedProducts = normalizeScrapedProducts(scrapeResult.products, {
          sourceUrl: scrapeResult.sourceUrl,
          config: sourceConfig
        });
        scrapeResult = { ...scrapeResult, products: normalizedProducts, totalProducts: normalizedProducts.length };
        await log("info", "Scrape discovered products", { totalProducts: scrapeResult.totalProducts });

        await throwIfCancelled("before_images");
        const imagesDir = path.join(dataDir, "images");
        const profileForRequests = isPlainObject(sourceConfig) ? parsePlaywrightProfile(sourceConfig) : undefined;
        const imageUserAgent = profileForRequests?.userAgent ?? defaultUserAgent;
        const imageAcceptLanguage = acceptLanguageForLocale(profileForRequests?.locale);
        const withImages = await mapWithConcurrency(scrapeResult.products, 8, async (p) => {
          if (!p.imageUrl) return p;
          try {
            const image = await downloadAndStoreImage({
              imageUrl: p.imageUrl,
              referer: scrapeResult.sourceUrl || "https://example.invalid/",
              imagesDir,
              userAgent: imageUserAgent,
              acceptLanguage: imageAcceptLanguage
            });
            return image ? { ...p, image } : p;
          } catch (err) {
            await log("warn", "Image download failed", {
              itemId: p.itemId,
              imageUrl: p.imageUrl,
              error: err instanceof Error ? err.message : String(err)
            });
            return p;
          }
        });

        const resultToWrite: ScrapeResult = {
          ...scrapeResult,
          products: withImages,
          totalProducts: withImages.length
        };

        await writeFile(productsJsonAbsPath, JSON.stringify(resultToWrite, null, 2), "utf8");
        await upsertRunArtifacts(true);
        await log("info", "Wrote run artifacts", {
          productsJson: `/media/${productsJsonPath}`,
          runLog: `/media/${runLogPath}`
        });

        await throwIfCancelled("before_ingest");
        let missingItemIdsForRun: number | undefined = undefined;
        if (convexForRun) {
          const scrapedAt = Date.parse(resultToWrite.scrapedAt);
          const productsWithItemId = resultToWrite.products.filter((p) => typeof p.itemId === "string" && p.itemId.trim());
          missingItemIdsForRun = Math.max(0, resultToWrite.totalProducts - productsWithItemId.length);
          if (missingItemIdsForRun > 0) {
            await log("warn", "Skipped products missing itemId", { missingItemIds: missingItemIdsForRun });
          }

          if (dryRun) {
            await log("info", "Dry run enabled; skipping Convex ingest", { productsWithItemId: productsWithItemId.length });
          } else {
            const ingestProducts = productsWithItemId.map((p) => ({
              itemId: p.itemId!.trim(),
              name: p.name,
              url: p.url,
              price: p.price,
              currency: p.currency,
              image: p.image
            }));

            const ingestResult = await convexForRun.mutation(productsIngestRun, {
              sessionToken: sessionToken!,
              runId,
              sourceSlug,
              scrapedAt: Number.isFinite(scrapedAt) ? scrapedAt : undefined,
              products: ingestProducts
            });
            await log("info", "Ingested products into Convex", ingestResult);
          }
        }

        const status: RunStatus = "completed";
        if (convexForRun) {
          await convexForRun.mutation(runsSetStatus, {
            sessionToken: sessionToken!,
            runId,
            status,
            productsFound: resultToWrite.totalProducts,
            missingItemIds: missingItemIdsForRun
          });
        }
        await log("info", "Run completed", { productsFound: resultToWrite.totalProducts });

        return { ok: true, status, runId, sourceSlug };
      } catch (err) {
        if (err instanceof CancelledError) {
          await logToFile(logPath, "warn", "Run canceled", { error: err.message });
          await upsertRunArtifacts(true);
          if (convexForRun) {
            await convexForRun.mutation(runsSetStatus, { sessionToken: sessionToken!, runId, status: "canceled" });
          }
          return { ok: true, status: "canceled" as const, runId, sourceSlug };
        }

        const message = err instanceof Error ? err.message : String(err);
        await logToFile(logPath, "error", "Run failed", { error: message });
        await upsertRunArtifacts(true);
        if (convexForRun) {
          await convexForRun.mutation(runsSetStatus, { sessionToken: sessionToken!, runId, status: "failed", error: message });
        }
        throw err;
      }
    },
    { connection, concurrency: concurrencyLimit }
  );

  worker.on("completed", (job) => {
    console.log(`[worker] completed job ${job.id} (${job.name})`);
  });

  worker.on("failed", (job, err) => {
    console.error(`[worker] failed job ${job?.id} (${job?.name}):`, err);
  });
}

main().catch((err) => {
  console.error("[worker] fatal:", err);
  process.exit(1);
});
