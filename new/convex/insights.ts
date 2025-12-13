import { queryGeneric } from "convex/server";
import { v } from "convex/values";
import { requireSession } from "./authz";

type Mover = {
  sourceSlug: string;
  sourceDisplayName: string;
  itemId: string;
  name: string;
  price: number;
  currency: string | null;
  prevPrice: number | null;
  changeAbs: number | null;
  changePct: number | null;
  lastSeenAt: number;
  url: string | null;
};

export const snapshot = queryGeneric({
  args: { sessionToken: v.string() },
  handler: async (ctx, args) => {
    await requireSession(ctx, args.sessionToken);

    const now = Date.now();
    const staleCutoffMs = 12 * 60 * 60 * 1000;
    const failureCutoffMs = 36 * 60 * 60 * 1000;

    const sources = await ctx.db.query("sources").collect();

    const staleSources = sources
      .filter((s) => typeof s.lastSuccessfulAt !== "number" || s.lastSuccessfulAt < now - staleCutoffMs)
      .map((s) => ({
        sourceSlug: s.slug,
        displayName: s.displayName,
        enabled: s.enabled,
        lastSuccessfulAt: typeof s.lastSuccessfulAt === "number" ? s.lastSuccessfulAt : null
      }))
      .sort((a, b) => (a.lastSuccessfulAt ?? 0) - (b.lastSuccessfulAt ?? 0));

    const failedRuns = await ctx.db
      .query("runs")
      .withIndex("by_status", (q) => q.eq("status", "failed"))
      .order("desc")
      .take(60);

    const recentFailures = failedRuns
      .filter((r) => {
        const ts = typeof r.startedAt === "number" ? r.startedAt : r._creationTime;
        return ts >= now - failureCutoffMs;
      })
      .slice(0, 10)
      .map((r) => ({
        runId: r._id,
        sourceSlug: r.sourceSlug,
        startedAt: typeof r.startedAt === "number" ? r.startedAt : r._creationTime,
        completedAt: typeof r.completedAt === "number" ? r.completedAt : null,
        error: typeof r.error === "string" ? r.error : null
      }));

    const drops: Mover[] = [];
    const spikes: Mover[] = [];
    let dropCount = 0;
    let spikeCount = 0;

    const dropThresholdPct = -8;
    const spikeThresholdPct = 12;
    const dropThresholdAbs = -5;
    const spikeThresholdAbs = 8;

    for (const s of sources) {
      const latestRunId = s.lastSuccessfulRunId;
      if (!latestRunId) continue;

      const products = await ctx.db
        .query("productsLatest")
        .withIndex("by_source_run_lastSeenAt", (q) =>
          q.eq("sourceSlug", s.slug).eq("lastSeenRunId", latestRunId)
        )
        .collect();

      for (const p of products) {
        if (typeof p.lastPrice !== "number") continue;

        const prevPrice = typeof p.prevPrice === "number" ? p.prevPrice : null;
        const changeAbs =
          typeof p.priceChange === "number" ? p.priceChange : prevPrice !== null ? p.lastPrice - prevPrice : null;
        const changePct =
          typeof p.priceChangePct === "number"
            ? p.priceChangePct
            : prevPrice !== null && prevPrice > 0 && changeAbs !== null
              ? (changeAbs / prevPrice) * 100
              : null;

        if (changeAbs === null && changePct === null) continue;

        const isDrop =
          (typeof changePct === "number" && changePct <= dropThresholdPct) ||
          (typeof changeAbs === "number" && changeAbs <= dropThresholdAbs);
        const isSpike =
          (typeof changePct === "number" && changePct >= spikeThresholdPct) ||
          (typeof changeAbs === "number" && changeAbs >= spikeThresholdAbs);

        if (!isDrop && !isSpike) continue;

        const currency = typeof p.currency === "string" ? p.currency : null;
        const url = typeof p.url === "string" ? p.url : null;

        const mover: Mover = {
          sourceSlug: s.slug,
          sourceDisplayName: s.displayName,
          itemId: p.itemId,
          name: p.name,
          price: p.lastPrice,
          currency,
          prevPrice,
          changeAbs,
          changePct,
          lastSeenAt: p.lastSeenAt,
          url
        };

        if (isDrop) {
          drops.push(mover);
          dropCount += 1;
        } else if (isSpike) {
          spikes.push(mover);
          spikeCount += 1;
        }
      }
    }

    drops.sort((a, b) => (a.changePct ?? 0) - (b.changePct ?? 0));
    spikes.sort((a, b) => (b.changePct ?? 0) - (a.changePct ?? 0));

    return {
      generatedAt: now,
      summary: {
        recentDrops: dropCount,
        recentSpikes: spikeCount,
        staleSources: staleSources.length,
        recentFailures: recentFailures.length
      },
      movers: {
        drops: drops.slice(0, 8),
        spikes: spikes.slice(0, 6)
      },
      staleSources,
      recentFailures
    };
  }
});

