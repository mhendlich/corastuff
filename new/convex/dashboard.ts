import { queryGeneric } from "convex/server";
import { v } from "convex/values";
import { requireSession } from "./authz";

export const stats = queryGeneric({
  args: { sessionToken: v.string() },
  handler: async (ctx, args) => {
    await requireSession(ctx, args.sessionToken);
    const sources = await ctx.db.query("sources").collect();
    const canonicals = await ctx.db.query("canonicalProducts").collect();
    let totalProducts = 0;
    let linkedProducts = 0;
    let unlinkedProducts = 0;

    for (const s of sources) {
      const latestRunId = s.lastSuccessfulRunId;
      const products = await ctx.db
        .query("productsLatest")
        .withIndex(
          latestRunId ? "by_source_run_lastSeenAt" : "by_sourceSlug_lastSeenAt",
          (q) =>
            latestRunId
              ? q.eq("sourceSlug", s.slug).eq("lastSeenRunId", latestRunId)
              : q.eq("sourceSlug", s.slug)
        )
        .collect();

      const links = await ctx.db
        .query("productLinks")
        .withIndex("by_source_item", (q) => q.eq("sourceSlug", s.slug))
        .collect();
      const linkedItemIds = new Set<string>(links.map((l) => l.itemId));

      totalProducts += products.length;
      for (const p of products) {
        if (linkedItemIds.has(p.itemId)) linkedProducts += 1;
        else unlinkedProducts += 1;
      }
    }

    return {
      sources: sources.length,
      canonicalProducts: canonicals.length,
      linkedProducts,
      unlinkedProducts,
      totalProducts
    };
  }
});

export const lastScrapes = queryGeneric({
  args: { sessionToken: v.string() },
  handler: async (ctx, args) => {
    await requireSession(ctx, args.sessionToken);
    const sources = await ctx.db.query("sources").withIndex("by_slug").collect();
    const out: Array<{
      sourceSlug: string;
      displayName: string;
      enabled: boolean;
      lastRunId: string | null;
      lastRunStatus: "pending" | "running" | "completed" | "failed" | "canceled" | null;
      lastRunAt: number | null;
      lastRunStartedAt: number | null;
      lastRunCompletedAt: number | null;
    }> = [];

    for (const s of sources) {
      const recent = await ctx.db
        .query("runs")
        .withIndex("by_sourceSlug", (q) => q.eq("sourceSlug", s.slug))
        .order("desc")
        .take(1);
      const r = recent[0] ?? null;
      const lastRunAt = r?.completedAt ?? r?.startedAt ?? r?._creationTime ?? null;
      out.push({
        sourceSlug: s.slug,
        displayName: s.displayName,
        enabled: s.enabled,
        lastRunId: r?._id ?? null,
        lastRunStatus: r?.status ?? null,
        lastRunAt,
        lastRunStartedAt: r?.startedAt ?? null,
        lastRunCompletedAt: r?.completedAt ?? null
      });
    }

    return out;
  }
});
