import { mutationGeneric, queryGeneric } from "convex/server";
import { v } from "convex/values";
import { requireSession } from "./authz";

const storedImage = v.object({
  hash: v.string(),
  mime: v.string(),
  bytes: v.number(),
  path: v.string(),
  mediaUrl: v.string()
});

const productIngest = v.object({
  itemId: v.string(),
  name: v.string(),
  url: v.optional(v.string()),
  price: v.optional(v.number()),
  currency: v.optional(v.string()),
  image: v.optional(storedImage)
});

export const listLatest = queryGeneric({
  args: {
    sessionToken: v.string(),
    limit: v.optional(v.number()),
    sourceSlug: v.optional(v.string())
  },
  handler: async (ctx, args) => {
    await requireSession(ctx, args.sessionToken);
    const limit = Math.min(Math.max(args.limit ?? 50, 1), 250);
    if (args.sourceSlug) {
      const sourceSlug = args.sourceSlug.trim();
      const source = await ctx.db
        .query("sources")
        .withIndex("by_slug", (q) => q.eq("slug", sourceSlug))
        .unique();
      const latestRunId = source?.lastSuccessfulRunId;
      if (latestRunId) {
        return await ctx.db
          .query("productsLatest")
          .withIndex("by_source_run_lastSeenAt", (q) =>
            q.eq("sourceSlug", sourceSlug).eq("lastSeenRunId", latestRunId)
          )
          .order("desc")
          .take(limit);
      }
      return await ctx.db
        .query("productsLatest")
        .withIndex("by_sourceSlug_lastSeenAt", (q) => q.eq("sourceSlug", sourceSlug))
        .order("desc")
        .take(limit);
    }
    return await ctx.db.query("productsLatest").order("desc").take(limit);
  }
});

export const ingestRun = mutationGeneric({
  args: {
    sessionToken: v.string(),
    runId: v.id("runs"),
    sourceSlug: v.string(),
    scrapedAt: v.optional(v.number()),
    products: v.array(productIngest)
  },
  handler: async (ctx, args) => {
    await requireSession(ctx, args.sessionToken);
    const now = Date.now();
    const seenAt = args.scrapedAt ?? now;

    if (args.products.length > 2500) {
      throw new Error(`Refusing to ingest ${args.products.length} products in one mutation (max 2500)`);
    }

    let inserted = 0;
    let updated = 0;
    let pricePoints = 0;

    for (const p of args.products) {
      const nextPrice = typeof p.price === "number" && Number.isFinite(p.price) ? p.price : null;
      const nextCurrency = typeof p.currency === "string" ? p.currency : null;

      let prevPrice: number | null = null;
      let prevPriceAt: number | null = null;
      if (nextPrice !== null) {
        const prev = await ctx.db
          .query("pricePoints")
          .withIndex("by_source_item_ts", (q) =>
            q.eq("sourceSlug", args.sourceSlug).eq("itemId", p.itemId).lt("ts", seenAt)
          )
          .order("desc")
          .take(1);
        if (prev[0]) {
          prevPrice = prev[0].price;
          prevPriceAt = prev[0].ts;
        }
      }

      const priceChange = prevPrice !== null && nextPrice !== null ? nextPrice - prevPrice : null;
      const priceChangePct =
        prevPrice !== null && nextPrice !== null && prevPrice > 0 ? (priceChange! / prevPrice) * 100 : null;

      const existing = await ctx.db
        .query("productsLatest")
        .withIndex("by_source_item", (q) => q.eq("sourceSlug", args.sourceSlug).eq("itemId", p.itemId))
        .unique();

      const patch: Record<string, unknown> = {
        name: p.name,
        lastSeenAt: seenAt,
        lastSeenRunId: args.runId,
        updatedAt: now
      };
      if (typeof p.url === "string") patch.url = p.url;
      if (nextCurrency !== null) patch.currency = nextCurrency;
      if (nextPrice !== null) patch.lastPrice = nextPrice;
      if (prevPrice !== null) patch.prevPrice = prevPrice;
      if (prevPriceAt !== null) patch.prevPriceAt = prevPriceAt;
      if (priceChange !== null) patch.priceChange = priceChange;
      if (priceChangePct !== null) patch.priceChangePct = priceChangePct;
      if (p.image) patch.image = p.image;

      if (existing) {
        await ctx.db.patch(existing._id, patch);
        updated += 1;
      } else {
        const record: Record<string, unknown> = {
          sourceSlug: args.sourceSlug,
          itemId: p.itemId,
          name: p.name,
          lastSeenAt: seenAt,
          lastSeenRunId: args.runId,
          updatedAt: now
        };
        if (typeof p.url === "string") record.url = p.url;
        if (nextCurrency !== null) record.currency = nextCurrency;
        if (nextPrice !== null) record.lastPrice = nextPrice;
        if (prevPrice !== null) record.prevPrice = prevPrice;
        if (prevPriceAt !== null) record.prevPriceAt = prevPriceAt;
        if (priceChange !== null) record.priceChange = priceChange;
        if (priceChangePct !== null) record.priceChangePct = priceChangePct;
        if (p.image) record.image = p.image;
        await ctx.db.insert("productsLatest", record);
        inserted += 1;
      }

      if (nextPrice !== null && nextCurrency !== null) {
        await ctx.db.insert("pricePoints", {
          sourceSlug: args.sourceSlug,
          itemId: p.itemId,
          ts: seenAt,
          price: nextPrice,
          currency: nextCurrency,
          runId: args.runId
        });
        pricePoints += 1;
      }
    }

    return { ok: true, inserted, updated, pricePoints };
  }
});
