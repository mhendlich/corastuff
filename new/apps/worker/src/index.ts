import { Worker } from "bullmq";
import { Redis } from "ioredis";
import { appendFile, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { ConvexHttpClient } from "convex/browser";
import { makeFunctionReference } from "convex/server";
import {
  SCRAPE_QUEUE_NAME,
  RUN_SCRAPER_JOB_NAME,
  getRunScraperScheduler,
  type RunScraperJobData
} from "@corastuff/queue";
import {
  scrapeGlobetrotterBrandPage,
  scrapeShopifyCollectionProductsJson,
  scrapeShopifyVendorListingProducts
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
  { sessionToken: string; runId: string; status: RunStatus; productsFound?: number; error?: string },
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

async function downloadAndStoreImage(options: {
  imageUrl: string;
  referer: string;
  imagesDir: string;
}): Promise<StoredImage | undefined> {
  const resp = await fetch(options.imageUrl, {
    redirect: "follow",
    headers: {
      Accept: "image/avif,image/webp,image/apng,image/*,*/*;q=0.8",
      Referer: options.referer,
      "User-Agent": defaultUserAgent,
      "Sec-Fetch-Dest": "image",
      "Sec-Fetch-Mode": "no-cors",
      "Sec-Fetch-Site": "cross-site"
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

function asNonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function parseShopifyCollectionConfig(
  sourceSlug: string,
  config: unknown
): {
  sourceSlug: string;
  sourceUrl: string;
  collectionProductsJsonUrl: string;
  productPathPrefix?: string;
  currency?: string;
} | null {
  if (typeof config !== "object" || config === null || Array.isArray(config)) return null;
  const cfg = config as Record<string, unknown>;

  const collectionProductsJsonUrl = asNonEmptyString(cfg.collectionProductsJsonUrl);
  if (!collectionProductsJsonUrl) return null;

  const currency = asNonEmptyString(cfg.currency);
  const productPathPrefix = asNonEmptyString(cfg.productPathPrefix);
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
} | null {
  if (typeof config !== "object" || config === null || Array.isArray(config)) return null;
  const cfg = config as Record<string, unknown>;

  const listingUrl = asNonEmptyString(cfg.listingUrl) ?? asNonEmptyString(cfg.sourceUrl);
  if (!listingUrl) return null;

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
  return { sourceSlug, baseUrl, listingUrl, ...(currency ? { currency } : {}) };
}

const FALLBACK_SOURCE_CONFIGS: Record<string, Record<string, unknown>> = {
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
  }
};

async function scrapeSource(args: {
  sourceSlug: string;
  config: unknown;
  log: (msg: string) => void;
}): Promise<ScrapeResult> {
  const globetrotter = args.sourceSlug === "globetrotter" ? parseGlobetrotterBrandConfig(args.sourceSlug, args.config) : null;
  if (globetrotter) {
    const { products } = await scrapeGlobetrotterBrandPage({
      sourceSlug: globetrotter.sourceSlug,
      listingUrl: globetrotter.listingUrl,
      baseUrl: globetrotter.baseUrl,
      currency: globetrotter.currency,
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

  const shopify = parseShopifyCollectionConfig(args.sourceSlug, args.config);
  if (shopify) {
    const { products } = await scrapeShopifyCollectionProductsJson({
      sourceSlug: shopify.sourceSlug,
      sourceUrl: shopify.sourceUrl,
      collectionProductsJsonUrl: shopify.collectionProductsJsonUrl,
      productPathPrefix: shopify.productPathPrefix,
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
    `No scraper implemented for sourceSlug "${args.sourceSlug}" (expected collectionProductsJsonUrl, vendorListingUrl, or listingUrl in config)`
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
      } catch (err) {
        console.warn("[worker] failed to authenticate to Convex; running without Convex updates:", err);
        convex = null;
      }
    }
  }

  const worker = new Worker(
    SCRAPE_QUEUE_NAME,
    async (job) => {
      if (job.name !== RUN_SCRAPER_JOB_NAME) {
        return { ok: true, ignored: true, name: job.name };
      }

      const data = job.data as RunScraperJobData;
      const sourceSlug = typeof data?.sourceSlug === "string" ? data.sourceSlug.trim() : "";
      const requestedBy = typeof data?.requestedBy === "string" ? data.requestedBy : undefined;
      let runId = typeof data?.runId === "string" ? data.runId.trim() : "";
      const wasRunIdMissing = !runId;
      if (!sourceSlug) {
        throw new Error("Invalid job payload: expected { sourceSlug: string }");
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
        if (convexForRun) {
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
              receivedAt: Date.now()
            }
          });

          if (sourceEnabled === false) {
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
        const scrapeResult = await scrapeSource({ sourceSlug, config: sourceConfig, log: (m) => {
          void log("info", m);
        }});
        await log("info", "Scrape discovered products", { totalProducts: scrapeResult.totalProducts });

        await throwIfCancelled("before_images");
        const imagesDir = path.join(dataDir, "images");
        const withImages = await mapWithConcurrency(scrapeResult.products, 8, async (p) => {
          if (!p.imageUrl) return p;
          try {
            const image = await downloadAndStoreImage({
              imageUrl: p.imageUrl,
              referer: scrapeResult.sourceUrl || "https://example.invalid/",
              imagesDir
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

        await writeFile(path.join(runDir, "products.json"), JSON.stringify(resultToWrite, null, 2), "utf8");
        const runDirName = path.basename(runDir);
        const productsJsonPath = `runs/${runDirName}/products.json`;
        const runLogPath = `runs/${runDirName}/run.log`;
        if (convexForRun) {
          await convexForRun.mutation(runArtifactsUpsertMany, {
            sessionToken: sessionToken!,
            runId,
            artifacts: [
              { key: "products.json", type: "json", path: productsJsonPath },
              { key: "run.log", type: "log", path: runLogPath }
            ]
          });
        }
        await log("info", "Wrote run artifacts", {
          productsJson: `/media/${productsJsonPath}`,
          runLog: `/media/${runLogPath}`
        });

        await throwIfCancelled("before_ingest");
        if (convexForRun) {
          const scrapedAt = Date.parse(resultToWrite.scrapedAt);
          const ingestProducts = resultToWrite.products
            .filter((p) => typeof p.itemId === "string" && p.itemId.trim())
            .map((p) => ({
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

        const status: RunStatus = "completed";
        if (convexForRun) {
          await convexForRun.mutation(runsSetStatus, {
            sessionToken: sessionToken!,
            runId,
            status,
            productsFound: resultToWrite.totalProducts
          });
        }
        await log("info", "Run completed", { productsFound: resultToWrite.totalProducts });

        return { ok: true, status, runId, sourceSlug };
      } catch (err) {
        if (err instanceof CancelledError) {
          await logToFile(logPath, "warn", "Run canceled", { error: err.message });
          if (convexForRun) {
            await convexForRun.mutation(runsSetStatus, { sessionToken: sessionToken!, runId, status: "canceled" });
          }
          return { ok: true, status: "canceled" as const, runId, sourceSlug };
        }

        const message = err instanceof Error ? err.message : String(err);
        await logToFile(logPath, "error", "Run failed", { error: message });
        if (convexForRun) {
          await convexForRun.mutation(runsSetStatus, { sessionToken: sessionToken!, runId, status: "failed", error: message });
        }
        throw err;
      }
    },
    { connection }
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
