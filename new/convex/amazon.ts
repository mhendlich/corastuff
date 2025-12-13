import { mutationGeneric, queryGeneric } from "convex/server";
import { v } from "convex/values";
import { requireSession } from "./authz";
import type { Id } from "./_generated/dataModel";

function defaultDisplayNameForSlug(sourceSlug: string) {
  if (sourceSlug === "amazon") return "Amazon";
  if (sourceSlug === "amazon_de") return "Amazon DE";
  if (sourceSlug.startsWith("amazon_")) return `Amazon (${sourceSlug.slice("amazon_".length)})`;
  return sourceSlug;
}

export const ensureAmazonSource = mutationGeneric({
  args: {
    sessionToken: v.string(),
    sourceSlug: v.optional(v.string()),
    displayName: v.optional(v.string()),
    enabled: v.optional(v.boolean())
  },
  handler: async (ctx, args) => {
    await requireSession(ctx, args.sessionToken);
    const sourceSlug = (args.sourceSlug ?? "amazon").trim();
    if (!sourceSlug) throw new Error("sourceSlug is required");

    const displayName = (args.displayName ?? defaultDisplayNameForSlug(sourceSlug)).trim() || sourceSlug;
    const enabled = args.enabled ?? false;

    const existing = await ctx.db.query("sources").withIndex("by_slug", (q) => q.eq("slug", sourceSlug)).unique();
    if (existing) {
      const patch: Record<string, unknown> = {};
      if (existing.displayName !== displayName) patch.displayName = displayName;
      if (existing.enabled !== enabled) patch.enabled = enabled;
      if (Object.keys(patch).length) await ctx.db.patch(existing._id, patch);
      return { id: existing._id, created: false };
    }

    const id = await ctx.db.insert("sources", {
      slug: sourceSlug,
      displayName,
      enabled,
      type: "http",
      config: { kind: "manual" }
    });
    return { id, created: true };
  }
});

export const upsertManualListing = mutationGeneric({
  args: {
    sessionToken: v.string(),
    sourceSlug: v.optional(v.string()),
    asin: v.string(),
    name: v.optional(v.string()),
    price: v.optional(v.union(v.number(), v.null())),
    currency: v.optional(v.union(v.string(), v.null())),
    url: v.optional(v.union(v.string(), v.null())),
    seenAt: v.optional(v.number())
  },
  handler: async (ctx, args) => {
    await requireSession(ctx, args.sessionToken);
    const sourceSlug = (args.sourceSlug ?? "amazon").trim();
    const asin = args.asin.trim();
    if (!sourceSlug) throw new Error("sourceSlug is required");
    if (!asin) throw new Error("asin is required");

    const now = Date.now();
    const seenAt = args.seenAt ?? now;

    const name = (args.name ?? asin).trim() || asin;
    const url = typeof args.url === "string" ? args.url.trim() || null : null;

    const nextPrice = typeof args.price === "number" && Number.isFinite(args.price) ? args.price : null;
    const nextCurrency =
      typeof args.currency === "string" && args.currency.trim()
        ? args.currency.trim()
        : nextPrice !== null
          ? "EUR"
          : null;

    const source = await ctx.db.query("sources").withIndex("by_slug", (q) => q.eq("slug", sourceSlug)).unique();
    if (!source) {
      await ctx.db.insert("sources", {
        slug: sourceSlug,
        displayName: defaultDisplayNameForSlug(sourceSlug),
        enabled: false,
        type: "http",
        config: { kind: "manual" },
        lastSuccessfulAt: seenAt
      });
    } else {
      await ctx.db.patch(source._id, { lastSuccessfulAt: seenAt });
    }

    let prevPrice: number | null = null;
    let prevPriceAt: number | null = null;
    let streakKind: "drop" | "rise" | null = null;
    let streakTrendPct: number | null = null;
    let streakPrices: number[] | null = null;

    const minStepPct = 1.0;
    if (nextPrice !== null) {
      const history = await ctx.db
        .query("pricePoints")
        .withIndex("by_source_item_ts", (q) => q.eq("sourceSlug", sourceSlug).eq("itemId", asin).lt("ts", seenAt))
        .order("desc")
        .take(3);

      if (history[0]) {
        prevPrice = history[0].price;
        prevPriceAt = history[0].ts;
      }

      if (history.length === 3) {
        const seriesOldestFirst = [...history].reverse().map((pt) => pt.price).concat([nextPrice]);
        const oldest = seriesOldestFirst[0]!;
        if (Number.isFinite(oldest) && oldest > 0) {
          let monotoneDown = true;
          let monotoneUp = true;
          for (let i = 1; i < seriesOldestFirst.length; i += 1) {
            const prev = seriesOldestFirst[i - 1]!;
            const cur = seriesOldestFirst[i]!;
            if (!Number.isFinite(prev) || prev <= 0) {
              monotoneDown = false;
              monotoneUp = false;
              break;
            }
            const stepPct = ((cur - prev) / prev) * 100;
            if (stepPct > -minStepPct) monotoneDown = false;
            if (stepPct < minStepPct) monotoneUp = false;
          }

          if (monotoneDown || monotoneUp) {
            streakKind = monotoneDown ? "drop" : "rise";
            streakTrendPct = ((nextPrice - oldest) / oldest) * 100;
            streakPrices = seriesOldestFirst;
          }
        }
      }
    }

    const priceChange = prevPrice !== null && nextPrice !== null ? nextPrice - prevPrice : null;
    const priceChangePct =
      prevPrice !== null && nextPrice !== null && prevPrice > 0 ? (priceChange! / prevPrice) * 100 : null;

    const existing = await ctx.db
      .query("productsLatest")
      .withIndex("by_source_item", (q) => q.eq("sourceSlug", sourceSlug).eq("itemId", asin))
      .unique();

    const patch: Record<string, unknown> = {
      name,
      lastSeenAt: seenAt,
      updatedAt: now
    };
    if (url !== null) patch.url = url;
    patch.currency = nextCurrency;
    patch.lastPrice = nextPrice;
    if (prevPrice !== null) patch.prevPrice = prevPrice;
    if (prevPriceAt !== null) patch.prevPriceAt = prevPriceAt;
    if (priceChange !== null) patch.priceChange = priceChange;
    if (priceChangePct !== null) patch.priceChangePct = priceChangePct;
    if (nextPrice !== null) {
      patch.streakKind = streakKind;
      patch.streakTrendPct = streakTrendPct;
      patch.streakPrices = streakPrices;
    }

    if (existing) {
      if (typeof existing.firstSeenAt !== "number") patch.firstSeenAt = existing._creationTime;
      if (nextPrice !== null) {
        const prevMin = typeof existing.minPrice === "number" ? existing.minPrice : nextPrice;
        const prevMax = typeof existing.maxPrice === "number" ? existing.maxPrice : nextPrice;
        patch.minPrevPrice = prevMin;
        patch.maxPrevPrice = prevMax;
        patch.minPrice = Math.min(prevMin, nextPrice);
        patch.maxPrice = Math.max(prevMax, nextPrice);
      }

      await ctx.db.patch(existing._id, patch);
    } else {
      const record: Record<string, unknown> = {
        sourceSlug,
        itemId: asin,
        name,
        lastSeenAt: seenAt,
        firstSeenAt: seenAt,
        updatedAt: now
      };
      if (url !== null) record.url = url;
      record.currency = nextCurrency;
      record.lastPrice = nextPrice;
      if (prevPrice !== null) record.prevPrice = prevPrice;
      if (prevPriceAt !== null) record.prevPriceAt = prevPriceAt;
      if (priceChange !== null) record.priceChange = priceChange;
      if (priceChangePct !== null) record.priceChangePct = priceChangePct;
      if (nextPrice !== null) {
        record.streakKind = streakKind;
        record.streakTrendPct = streakTrendPct;
        record.streakPrices = streakPrices;
        record.minPrice = nextPrice;
        record.maxPrice = nextPrice;
        record.minPrevPrice = nextPrice;
        record.maxPrevPrice = nextPrice;
      }
      await ctx.db.insert("productsLatest", record);
    }

    let pricePointId: Id<"pricePoints"> | null = null;
    if (nextPrice !== null && nextCurrency !== null) {
      const id = await ctx.db.insert("pricePoints", {
        sourceSlug,
        itemId: asin,
        ts: seenAt,
        price: nextPrice,
        currency: nextCurrency
      });
      pricePointId = id;
    }

    return {
      ok: true,
      sourceSlug,
      asin,
      wrotePricePoint: nextPrice !== null && nextCurrency !== null,
      pricePointId
    };
  }
});

export const listManualListings = queryGeneric({
  args: {
    sessionToken: v.string(),
    sourceSlug: v.optional(v.string()),
    limit: v.optional(v.number())
  },
  handler: async (ctx, args) => {
    await requireSession(ctx, args.sessionToken);
    const sourceSlug = (args.sourceSlug ?? "amazon").trim();
    const limit = Math.min(Math.max(args.limit ?? 100, 1), 500);
    if (!sourceSlug) throw new Error("sourceSlug is required");
    return await ctx.db
      .query("productsLatest")
      .withIndex("by_sourceSlug_lastSeenAt", (q) => q.eq("sourceSlug", sourceSlug))
      .order("desc")
      .take(limit);
  }
});

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function clampNumber(value: unknown, min: number, max: number, fallback: number) {
  if (!isFiniteNumber(value)) return fallback;
  return Math.min(Math.max(value, min), max);
}

function isAmazonSource(sourceSlug: string, amazonPrefix: string) {
  return sourceSlug === amazonPrefix || sourceSlug.startsWith(`${amazonPrefix}_`);
}

export const pricingOpportunities = queryGeneric({
  args: {
    sessionToken: v.string(),
    amazonPrefix: v.optional(v.string()),
    undercutBy: v.optional(v.number()),
    tolerance: v.optional(v.number()),
    onlyWithAmazon: v.optional(v.boolean()),
    canonicalLimit: v.optional(v.number())
  },
  handler: async (ctx, args) => {
    await requireSession(ctx, args.sessionToken);

    const amazonPrefix = (args.amazonPrefix ?? "amazon").trim() || "amazon";
    const undercutBy = clampNumber(args.undercutBy, 0, 1000, 0.01);
    const tolerance = clampNumber(args.tolerance, 0, 1000, 0.01);
    const onlyWithAmazon = args.onlyWithAmazon ?? true;
    const canonicalLimit = Math.min(Math.max(Math.trunc(args.canonicalLimit ?? 500), 1), 2000);

    const sources = await ctx.db.query("sources").collect();
    const displayNameBySlug = new Map<string, string>(sources.map((s) => [s.slug, s.displayName]));

    const canonicals = await ctx.db.query("canonicalProducts").order("desc").take(canonicalLimit);

    type PricingItem = {
      canonicalId: string;
      canonicalName: string | null;
      canonicalDescription: string | null;
      action:
        | "undercut"
        | "raise"
        | "watch"
        | "missing_amazon"
        | "missing_competitors"
        | "missing_own_price";
      amazonListingCount: number;
      primaryAmazon: {
        sourceSlug: string;
        sourceDisplayName: string;
        itemId: string;
        name: string | null;
        price: number | null;
        currency: string | null;
        url: string | null;
      } | null;
      competitorCount: number;
      competitorMin: {
        sourceSlug: string;
        sourceDisplayName: string;
        itemId: string;
        name: string | null;
        price: number;
        currency: string | null;
        url: string | null;
      } | null;
      ownPrice: number | null;
      ownCurrency: string | null;
      deltaAbs: number | null;
      deltaPct: number | null;
      suggestedPrice: number | null;
      suggestedReason: string | null;
    };

    const items: PricingItem[] = [];

    for (const canonical of canonicals) {
      const links = await ctx.db
        .query("productLinks")
        .withIndex("by_canonical", (q) => q.eq("canonicalId", canonical._id))
        .collect();

      const amazonLinks = links.filter((l) => isAmazonSource(l.sourceSlug, amazonPrefix));
      const competitorLinks = links.filter((l) => !isAmazonSource(l.sourceSlug, amazonPrefix));

      if (!amazonLinks.length) {
        if (onlyWithAmazon) continue;
        items.push({
          canonicalId: canonical._id,
          canonicalName: canonical.name ?? null,
          canonicalDescription: canonical.description ?? null,
          action: "missing_amazon",
          amazonListingCount: 0,
          primaryAmazon: null,
          competitorCount: 0,
          competitorMin: null,
          ownPrice: null,
          ownCurrency: null,
          deltaAbs: null,
          deltaPct: null,
          suggestedPrice: null,
          suggestedReason: null
        });
        continue;
      }

      const amazonListings: Array<NonNullable<PricingItem["primaryAmazon"]>> = [];
      for (const link of amazonLinks) {
        const product = await ctx.db
          .query("productsLatest")
          .withIndex("by_source_item", (q) => q.eq("sourceSlug", link.sourceSlug).eq("itemId", link.itemId))
          .unique();

        amazonListings.push({
          sourceSlug: link.sourceSlug,
          sourceDisplayName: displayNameBySlug.get(link.sourceSlug) ?? link.sourceSlug,
          itemId: link.itemId,
          name: product?.name ?? null,
          price: isFiniteNumber(product?.lastPrice) ? product.lastPrice : null,
          currency: typeof product?.currency === "string" ? product.currency : null,
          url: typeof product?.url === "string" ? product.url : null
        });
      }

      const amazonWithPrice = amazonListings.filter((l) => isFiniteNumber(l.price));
      const primaryAmazon =
        amazonWithPrice.length > 0
          ? amazonWithPrice.reduce((best, cur) => ((cur.price ?? Infinity) < (best.price ?? Infinity) ? cur : best))
          : amazonListings[0] ?? null;

      const ownPrice = primaryAmazon && isFiniteNumber(primaryAmazon.price) ? primaryAmazon.price : null;
      const ownCurrency = primaryAmazon?.currency ?? null;

      if (ownPrice === null) {
        items.push({
          canonicalId: canonical._id,
          canonicalName: canonical.name ?? null,
          canonicalDescription: canonical.description ?? null,
          action: "missing_own_price",
          amazonListingCount: amazonLinks.length,
          primaryAmazon,
          competitorCount: 0,
          competitorMin: null,
          ownPrice: null,
          ownCurrency,
          deltaAbs: null,
          deltaPct: null,
          suggestedPrice: null,
          suggestedReason: null
        });
        continue;
      }

      const competitors: Array<NonNullable<PricingItem["competitorMin"]>> = [];
      for (const link of competitorLinks) {
        const product = await ctx.db
          .query("productsLatest")
          .withIndex("by_source_item", (q) => q.eq("sourceSlug", link.sourceSlug).eq("itemId", link.itemId))
          .unique();

        const price = product?.lastPrice;
        if (!isFiniteNumber(price)) continue;

        competitors.push({
          sourceSlug: link.sourceSlug,
          sourceDisplayName: displayNameBySlug.get(link.sourceSlug) ?? link.sourceSlug,
          itemId: link.itemId,
          name: product?.name ?? null,
          price,
          currency: typeof product?.currency === "string" ? product.currency : null,
          url: typeof product?.url === "string" ? product.url : null
        });
      }

      if (!competitors.length) {
        items.push({
          canonicalId: canonical._id,
          canonicalName: canonical.name ?? null,
          canonicalDescription: canonical.description ?? null,
          action: "missing_competitors",
          amazonListingCount: amazonLinks.length,
          primaryAmazon,
          competitorCount: 0,
          competitorMin: null,
          ownPrice,
          ownCurrency,
          deltaAbs: null,
          deltaPct: null,
          suggestedPrice: null,
          suggestedReason: null
        });
        continue;
      }

      const competitorMin = competitors.reduce((best, cur) => (cur.price < best.price ? cur : best));
      if (!isFiniteNumber(competitorMin.price) || competitorMin.price <= 0) {
        items.push({
          canonicalId: canonical._id,
          canonicalName: canonical.name ?? null,
          canonicalDescription: canonical.description ?? null,
          action: "missing_competitors",
          amazonListingCount: amazonLinks.length,
          primaryAmazon,
          competitorCount: competitors.length,
          competitorMin: null,
          ownPrice,
          ownCurrency,
          deltaAbs: null,
          deltaPct: null,
          suggestedPrice: null,
          suggestedReason: null
        });
        continue;
      }

      const deltaAbs = ownPrice - competitorMin.price;
      const deltaPct = (deltaAbs / competitorMin.price) * 100;

      let action: PricingItem["action"] = "watch";
      let suggestedPrice: number | null = null;
      let suggestedReason: string | null = null;

      if (deltaAbs > tolerance) {
        action = "undercut";
        suggestedPrice = Math.max(competitorMin.price - undercutBy, 0);
        suggestedReason = `Undercut ${competitorMin.sourceDisplayName} by ${undercutBy.toFixed(2)}`;
      } else if (deltaAbs < -tolerance) {
        action = "raise";
        suggestedPrice = competitorMin.price;
        suggestedReason = `Match lowest retailer (${competitorMin.sourceDisplayName})`;
      } else {
        action = "watch";
      }

      items.push({
        canonicalId: canonical._id,
        canonicalName: canonical.name ?? null,
        canonicalDescription: canonical.description ?? null,
        action,
        amazonListingCount: amazonLinks.length,
        primaryAmazon,
        competitorCount: competitors.length,
        competitorMin,
        ownPrice,
        ownCurrency,
        deltaAbs,
        deltaPct,
        suggestedPrice,
        suggestedReason
      });
    }

    items.sort((a, b) => {
      const bucket = (it: PricingItem) => {
        if (it.action === "undercut") return 0;
        if (it.action === "raise") return 1;
        if (it.action === "watch") return 2;
        if (it.action === "missing_own_price") return 3;
        if (it.action === "missing_competitors") return 4;
        return 5;
      };
      const da = isFiniteNumber(a.deltaAbs) ? Math.abs(a.deltaAbs) : 0;
      const db = isFiniteNumber(b.deltaAbs) ? Math.abs(b.deltaAbs) : 0;

      const ba = bucket(a);
      const bb = bucket(b);
      if (ba !== bb) return ba - bb;
      if (ba === 0 || ba === 1) return db - da;
      return (a.canonicalName ?? "").localeCompare(b.canonicalName ?? "");
    });

    const undercut = items.filter((i) => i.action === "undercut");
    const raiseOps = items.filter((i) => i.action === "raise");
    const watch = items.filter((i) => i.action === "watch");
    const missingCompetitors = items.filter((i) => i.action === "missing_competitors");
    const missingOwnPrice = items.filter((i) => i.action === "missing_own_price");

    const totalOverprice = undercut.reduce((sum, it) => sum + (isFiniteNumber(it.deltaAbs) ? it.deltaAbs : 0), 0);
    const totalPotentialGain = raiseOps.reduce((sum, it) => {
      if (!isFiniteNumber(it.ownPrice) || !isFiniteNumber(it.suggestedPrice)) return sum;
      return sum + (it.suggestedPrice - it.ownPrice);
    }, 0);

    return {
      generatedAt: Date.now(),
      summary: {
        totalTracked: items.length,
        undercutCount: undercut.length,
        raiseCount: raiseOps.length,
        watchCount: watch.length,
        missingCompetitorsCount: missingCompetitors.length,
        missingOwnPriceCount: missingOwnPrice.length,
        missingDataCount: missingCompetitors.length + missingOwnPrice.length,
        totalOverprice,
        totalPotentialGain
      },
      items
    };
  }
});
