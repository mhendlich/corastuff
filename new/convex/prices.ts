import { queryGeneric } from "convex/server";
import { v } from "convex/values";
import { requireSession } from "./authz";

function clampInt(value: number, min: number, max: number) {
  if (!Number.isFinite(value)) return min;
  return Math.min(Math.max(Math.trunc(value), min), max);
}

function normalizeQuery(q: string | undefined) {
  const normalized = (q ?? "").trim().toLowerCase();
  return normalized.length ? normalized : null;
}

export const listForProduct = queryGeneric({
  args: {
    sessionToken: v.string(),
    sourceSlug: v.string(),
    itemId: v.string(),
    limit: v.optional(v.number())
  },
  handler: async (ctx, args) => {
    await requireSession(ctx, args.sessionToken);
    const sourceSlug = args.sourceSlug.trim();
    const itemId = args.itemId.trim();
    if (!sourceSlug) throw new Error("sourceSlug is required");
    if (!itemId) throw new Error("itemId is required");

    const limit = clampInt(args.limit ?? 50, 1, 500);
    return await ctx.db
      .query("pricePoints")
      .withIndex("by_source_item_ts", (q) => q.eq("sourceSlug", sourceSlug).eq("itemId", itemId))
      .order("desc")
      .take(limit);
  }
});

export const overview = queryGeneric({
  args: {
    sessionToken: v.string(),
    sourceSlug: v.optional(v.string()),
    q: v.optional(v.string()),
    minPrice: v.optional(v.number()),
    maxPrice: v.optional(v.number()),
    limitPerSource: v.optional(v.number())
  },
  handler: async (ctx, args) => {
    await requireSession(ctx, args.sessionToken);

    const q = normalizeQuery(args.q);
    const minPrice = typeof args.minPrice === "number" && Number.isFinite(args.minPrice) ? args.minPrice : null;
    const maxPrice = typeof args.maxPrice === "number" && Number.isFinite(args.maxPrice) ? args.maxPrice : null;
    const limitPerSource = clampInt(args.limitPerSource ?? 200, 1, 1000);

    const sourceSlug = typeof args.sourceSlug === "string" ? args.sourceSlug.trim() : "";
    const sourcesAll = await ctx.db.query("sources").withIndex("by_slug").collect();
    const sources = sourceSlug ? sourcesAll.filter((s) => s.slug === sourceSlug) : sourcesAll;

    const sourcesOut: Array<{
      sourceSlug: string;
      displayName: string;
      enabled: boolean;
      lastSuccessfulAt: number | null;
      products: Array<{
        sourceSlug: string;
        itemId: string;
        name: string;
        url: string | null;
        lastPrice: number;
        currency: string | null;
        prevPrice: number | null;
        priceChange: number | null;
        priceChangePct: number | null;
        lastSeenAt: number;
        image: any | null;
      }>;
    }> = [];

    for (const source of sources) {
      const latestRunId = source.lastSuccessfulRunId;
      const scan = clampInt(limitPerSource * 8, 200, 5000);

      const candidates = await ctx.db
        .query("productsLatest")
        .withIndex(
          latestRunId ? "by_source_run_lastSeenAt" : "by_sourceSlug_lastSeenAt",
          (q2) =>
            latestRunId
              ? q2.eq("sourceSlug", source.slug).eq("lastSeenRunId", latestRunId)
              : q2.eq("sourceSlug", source.slug)
        )
        .order("desc")
        .take(scan);

      const products: Array<(typeof sourcesOut)[number]["products"][number]> = [];
      for (const p of candidates) {
        if (typeof p.lastPrice !== "number" || !Number.isFinite(p.lastPrice)) continue;
        if (minPrice !== null && p.lastPrice < minPrice) continue;
        if (maxPrice !== null && p.lastPrice > maxPrice) continue;
        if (q) {
          const hay = `${p.name ?? ""} ${p.itemId ?? ""}`.toLowerCase();
          if (!hay.includes(q)) continue;
        }

        const prevPrice = typeof p.prevPrice === "number" && Number.isFinite(p.prevPrice) ? p.prevPrice : null;
        const priceChange =
          typeof p.priceChange === "number" && Number.isFinite(p.priceChange)
            ? p.priceChange
            : prevPrice !== null
              ? p.lastPrice - prevPrice
              : null;
        const priceChangePct =
          typeof p.priceChangePct === "number" && Number.isFinite(p.priceChangePct)
            ? p.priceChangePct
            : prevPrice !== null && prevPrice > 0 && priceChange !== null
              ? (priceChange / prevPrice) * 100
              : null;

        products.push({
          sourceSlug: source.slug,
          itemId: p.itemId,
          name: p.name,
          url: typeof p.url === "string" ? p.url : null,
          lastPrice: p.lastPrice,
          currency: typeof p.currency === "string" ? p.currency : null,
          prevPrice,
          priceChange,
          priceChangePct,
          lastSeenAt: p.lastSeenAt,
          image: (p as any).image ?? null
        });

        if (products.length >= limitPerSource) break;
      }

      sourcesOut.push({
        sourceSlug: source.slug,
        displayName: source.displayName,
        enabled: source.enabled,
        lastSuccessfulAt: typeof source.lastSuccessfulAt === "number" ? source.lastSuccessfulAt : null,
        products
      });
    }

    return {
      generatedAt: Date.now(),
      sources: sourcesOut
    };
  }
});

export const productDetail = queryGeneric({
  args: {
    sessionToken: v.string(),
    sourceSlug: v.string(),
    itemId: v.string(),
    limit: v.optional(v.number())
  },
  handler: async (ctx, args) => {
    await requireSession(ctx, args.sessionToken);
    const sourceSlug = args.sourceSlug.trim();
    const itemId = args.itemId.trim();
    if (!sourceSlug) throw new Error("sourceSlug is required");
    if (!itemId) throw new Error("itemId is required");

    const product = await ctx.db
      .query("productsLatest")
      .withIndex("by_source_item", (q) => q.eq("sourceSlug", sourceSlug).eq("itemId", itemId))
      .unique();
    if (!product) return null;

    const limit = clampInt(args.limit ?? 250, 1, 2000);
    const history = await ctx.db
      .query("pricePoints")
      .withIndex("by_source_item_ts", (q) => q.eq("sourceSlug", sourceSlug).eq("itemId", itemId))
      .order("desc")
      .take(limit);

    const link = await ctx.db
      .query("productLinks")
      .withIndex("by_source_item", (q) => q.eq("sourceSlug", sourceSlug).eq("itemId", itemId))
      .unique();
    const canonical = link ? await ctx.db.get(link.canonicalId) : null;

    const source = await ctx.db.query("sources").withIndex("by_slug", (q) => q.eq("slug", sourceSlug)).unique();

    return {
      source: source ? { slug: source.slug, displayName: source.displayName } : { slug: sourceSlug, displayName: sourceSlug },
      product,
      history,
      link,
      canonical
    };
  }
});

export const canonicalComparison = queryGeneric({
  args: {
    sessionToken: v.string(),
    canonicalId: v.id("canonicalProducts"),
    limitPerProduct: v.optional(v.number())
  },
  handler: async (ctx, args) => {
    await requireSession(ctx, args.sessionToken);
    const canonical = await ctx.db.get(args.canonicalId);
    if (!canonical) return null;

    const limitPerProduct = clampInt(args.limitPerProduct ?? 250, 1, 2000);

    const sources = await ctx.db.query("sources").collect();
    const displayNameBySlug = new Map<string, string>(sources.map((s) => [s.slug, s.displayName]));

    const links = await ctx.db
      .query("productLinks")
      .withIndex("by_canonical", (q) => q.eq("canonicalId", args.canonicalId))
      .collect();

    const items: Array<{
      sourceSlug: string;
      sourceDisplayName: string;
      itemId: string;
      name: string | null;
      url: string | null;
      currency: string | null;
      currentPrice: number | null;
      image: any | null;
      history: any[];
    }> = [];

    let bestPrice: number | null = null;
    let bestKey: string | null = null;

    for (const link of links) {
      const latest = await ctx.db
        .query("productsLatest")
        .withIndex("by_source_item", (q) => q.eq("sourceSlug", link.sourceSlug).eq("itemId", link.itemId))
        .unique();

      const currentPrice = typeof latest?.lastPrice === "number" && Number.isFinite(latest.lastPrice) ? latest.lastPrice : null;
      if (currentPrice !== null && (bestPrice === null || currentPrice < bestPrice)) {
        bestPrice = currentPrice;
        bestKey = `${link.sourceSlug}:${link.itemId}`;
      }

      const history = await ctx.db
        .query("pricePoints")
        .withIndex("by_source_item_ts", (q) => q.eq("sourceSlug", link.sourceSlug).eq("itemId", link.itemId))
        .order("desc")
        .take(limitPerProduct);

      const currency =
        typeof latest?.currency === "string"
          ? latest.currency
          : history[0] && typeof history[0].currency === "string"
            ? history[0].currency
            : null;

      items.push({
        sourceSlug: link.sourceSlug,
        sourceDisplayName: displayNameBySlug.get(link.sourceSlug) ?? link.sourceSlug,
        itemId: link.itemId,
        name: latest?.name ?? null,
        url: typeof latest?.url === "string" ? latest.url : null,
        currency,
        currentPrice,
        image: (latest as any)?.image ?? null,
        history
      });
    }

    items.sort((a, b) => {
      if (a.currentPrice === null && b.currentPrice !== null) return 1;
      if (a.currentPrice !== null && b.currentPrice === null) return -1;
      if (a.currentPrice !== null && b.currentPrice !== null) return a.currentPrice - b.currentPrice;
      return a.sourceSlug.localeCompare(b.sourceSlug);
    });

    return { canonical, bestKey, items };
  }
});
