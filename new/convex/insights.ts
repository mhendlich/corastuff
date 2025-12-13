import { queryGeneric } from "convex/server";
import { v } from "convex/values";
import { requireSession } from "./authz";
import type { Id } from "./_generated/dataModel";

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

type Extreme = {
  sourceSlug: string;
  sourceDisplayName: string;
  itemId: string;
  name: string;
  price: number;
  currency: string | null;
  prevExtremePrice: number | null;
  extremePrice: number | null;
  changePct: number | null;
  firstSeenAt: number | null;
  lastSeenAt: number;
  url: string | null;
};

type Outlier = {
  canonicalId: Id<"canonicalProducts">;
  canonicalName: string | null;
  currency: string;
  medianPrice: number;
  deviationPct: number;
  sourceSlug: string;
  sourceDisplayName: string;
  itemId: string;
  name: string;
  price: number;
  lastSeenAt: number;
  url: string | null;
};

type StreakTrend = {
  sourceSlug: string;
  sourceDisplayName: string;
  itemId: string;
  name: string;
  price: number;
  currency: string | null;
  trendPct: number;
  prices: number[];
  lastSeenAt: number;
  url: string | null;
};

type SourceCoverage = {
  sourceSlug: string;
  displayName: string;
  enabled: boolean;
  totalProducts: number;
  unlinkedProducts: number;
  missingPrices: number;
  coveragePct: number;
  lastSeenAt: number | null;
};

type CanonicalCoverageGap = {
  canonicalId: Id<"canonicalProducts">;
  name: string;
  createdAt: number;
  linkCount: number;
  firstLinkedAt: number | null;
  lastLinkedAt: number | null;
};

function median(values: number[]) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 0) return (sorted[mid - 1]! + sorted[mid]!) / 2;
  return sorted[mid]!;
}

export const snapshot = queryGeneric({
  args: { sessionToken: v.string() },
  handler: async (ctx, args) => {
    await requireSession(ctx, args.sessionToken);

    const now = Date.now();
    const staleCutoffMs = 12 * 60 * 60 * 1000;
    const failureCutoffMs = 36 * 60 * 60 * 1000;

    const sources = await ctx.db.query("sources").collect();
    const links = await ctx.db.query("productLinks").collect();
    const linkedPairs = new Set<string>(links.map((l) => `${l.sourceSlug}:${l.itemId}`));

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

    const newLows: Extreme[] = [];
    const newHighs: Extreme[] = [];
    let newExtremesCount = 0;

    const sustainedDrops: StreakTrend[] = [];
    const sustainedRises: StreakTrend[] = [];

    const coverageBySource: SourceCoverage[] = [];
    let totalUnlinked = 0;
    let totalMissingPrices = 0;

    const dropThresholdPct = -8;
    const spikeThresholdPct = 12;
    const dropThresholdAbs = -5;
    const spikeThresholdAbs = 8;
    const outlierThresholdPct = 18;
    const epsilon = 0.01;

    const latestBySourceItem = new Map<
      string,
      {
        sourceSlug: string;
        sourceDisplayName: string;
        itemId: string;
        name: string;
        price: number;
        currency: string;
        lastSeenAt: number;
        url: string | null;
      }
    >();

    for (const s of sources) {
      const latestRunId = s.lastSuccessfulRunId;
      if (!latestRunId) continue;

      const products = await ctx.db
        .query("productsLatest")
        .withIndex("by_source_run_lastSeenAt", (q) =>
          q.eq("sourceSlug", s.slug).eq("lastSeenRunId", latestRunId)
        )
        .collect();

      let sourceTotal = 0;
      let sourceUnlinked = 0;
      let sourceMissingPrice = 0;
      let sourceLastSeenAt: number | null = null;

      for (const p of products) {
        sourceTotal += 1;
        if (!linkedPairs.has(`${s.slug}:${p.itemId}`)) sourceUnlinked += 1;
        if (typeof p.lastPrice !== "number") sourceMissingPrice += 1;
        if (typeof p.lastSeenAt === "number") sourceLastSeenAt = Math.max(sourceLastSeenAt ?? 0, p.lastSeenAt);

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

        const currency = typeof p.currency === "string" ? p.currency : null;
        const url = typeof p.url === "string" ? p.url : null;

        if (currency !== null) {
          latestBySourceItem.set(`${s.slug}:${p.itemId}`, {
            sourceSlug: s.slug,
            sourceDisplayName: s.displayName,
            itemId: p.itemId,
            name: p.name,
            price: p.lastPrice,
            currency,
            lastSeenAt: p.lastSeenAt,
            url
          });
        }

        const streakKind = p.streakKind;
        const streakTrendPct = p.streakTrendPct;
        const streakPrices = p.streakPrices;
        if (
          (streakKind === "drop" || streakKind === "rise") &&
          typeof streakTrendPct === "number" &&
          Array.isArray(streakPrices) &&
          streakPrices.length >= 4
        ) {
          const trend: StreakTrend = {
            sourceSlug: s.slug,
            sourceDisplayName: s.displayName,
            itemId: p.itemId,
            name: p.name,
            price: p.lastPrice,
            currency,
            trendPct: streakTrendPct,
            prices: streakPrices,
            lastSeenAt: p.lastSeenAt,
            url
          };
          if (streakKind === "drop") sustainedDrops.push(trend);
          else sustainedRises.push(trend);
        }

        const minPrevPrice = typeof p.minPrevPrice === "number" ? p.minPrevPrice : null;
        const maxPrevPrice = typeof p.maxPrevPrice === "number" ? p.maxPrevPrice : null;

        const minPrice = typeof p.minPrice === "number" ? p.minPrice : null;
        const maxPrice = typeof p.maxPrice === "number" ? p.maxPrice : null;

        const firstSeenAt = typeof p.firstSeenAt === "number" ? p.firstSeenAt : null;

        if (minPrevPrice !== null && p.lastPrice <= minPrevPrice - epsilon) {
          newLows.push({
            sourceSlug: s.slug,
            sourceDisplayName: s.displayName,
            itemId: p.itemId,
            name: p.name,
            price: p.lastPrice,
            currency,
            prevExtremePrice: minPrevPrice,
            extremePrice: minPrice,
            changePct,
            firstSeenAt,
            lastSeenAt: p.lastSeenAt,
            url
          });
          newExtremesCount += 1;
        }

        if (maxPrevPrice !== null && p.lastPrice >= maxPrevPrice + epsilon) {
          newHighs.push({
            sourceSlug: s.slug,
            sourceDisplayName: s.displayName,
            itemId: p.itemId,
            name: p.name,
            price: p.lastPrice,
            currency,
            prevExtremePrice: maxPrevPrice,
            extremePrice: maxPrice,
            changePct,
            firstSeenAt,
            lastSeenAt: p.lastSeenAt,
            url
          });
          newExtremesCount += 1;
        }

        if (changeAbs === null && changePct === null) continue;

        const isDrop =
          (typeof changePct === "number" && changePct <= dropThresholdPct) ||
          (typeof changeAbs === "number" && changeAbs <= dropThresholdAbs);
        const isSpike =
          (typeof changePct === "number" && changePct >= spikeThresholdPct) ||
          (typeof changeAbs === "number" && changeAbs >= spikeThresholdAbs);

        if (!isDrop && !isSpike) continue;

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

      if (sourceTotal > 0) {
        totalUnlinked += sourceUnlinked;
        totalMissingPrices += sourceMissingPrice;
        coverageBySource.push({
          sourceSlug: s.slug,
          displayName: s.displayName,
          enabled: s.enabled,
          totalProducts: sourceTotal,
          unlinkedProducts: sourceUnlinked,
          missingPrices: sourceMissingPrice,
          coveragePct: sourceTotal > 0 ? Math.round((1 - sourceUnlinked / sourceTotal) * 1000) / 10 : 0,
          lastSeenAt: sourceLastSeenAt
        });
      }
    }

    drops.sort((a, b) => (a.changePct ?? 0) - (b.changePct ?? 0));
    spikes.sort((a, b) => (b.changePct ?? 0) - (a.changePct ?? 0));

    newLows.sort((a, b) => (a.changePct ?? 0) - (b.changePct ?? 0));
    newHighs.sort((a, b) => (b.changePct ?? 0) - (a.changePct ?? 0));

    const byCanonicalCurrency = new Map<string, { canonicalId: string; currency: string; items: Outlier[] }>();

    for (const link of links) {
      const latest = latestBySourceItem.get(`${link.sourceSlug}:${link.itemId}`);
      if (!latest) continue;
      if (!Number.isFinite(latest.price)) continue;
      const key = `${link.canonicalId}:${latest.currency}`;
      const entry: Outlier = {
        canonicalId: link.canonicalId,
        canonicalName: null,
        currency: latest.currency,
        medianPrice: 0,
        deviationPct: 0,
        sourceSlug: latest.sourceSlug,
        sourceDisplayName: latest.sourceDisplayName,
        itemId: latest.itemId,
        name: latest.name,
        price: latest.price,
        lastSeenAt: latest.lastSeenAt,
        url: latest.url
      };
      const bucket = byCanonicalCurrency.get(key);
      if (bucket) {
        bucket.items.push(entry);
      } else {
        byCanonicalCurrency.set(key, { canonicalId: link.canonicalId, currency: latest.currency, items: [entry] });
      }
    }

    const outliers: Outlier[] = [];
    const outlierCanonicalIds = new Set<Id<"canonicalProducts">>();
    let outlierCount = 0;

    for (const bucket of byCanonicalCurrency.values()) {
      if (bucket.items.length < 3) continue;
      const prices = bucket.items.map((i) => i.price);
      const med = median(prices);
      if (med === null || !Number.isFinite(med) || med <= 0) continue;

      for (const item of bucket.items) {
        const deviationPct = ((item.price - med) / med) * 100;
        if (Math.abs(deviationPct) < outlierThresholdPct) continue;
        outliers.push({
          ...item,
          medianPrice: med,
          deviationPct
        });
        outlierCount += 1;
        outlierCanonicalIds.add(bucket.canonicalId);
      }
    }

    const canonicalNameById = new Map<Id<"canonicalProducts">, string>();
    for (const id of outlierCanonicalIds) {
      const doc = await ctx.db.get(id);
      if (doc) canonicalNameById.set(id, doc.name);
    }

    for (const o of outliers) {
      o.canonicalName = canonicalNameById.get(o.canonicalId) ?? null;
    }

    outliers.sort((a, b) => Math.abs(b.deviationPct) - Math.abs(a.deviationPct));

    sustainedDrops.sort((a, b) => a.trendPct - b.trendPct);
    sustainedRises.sort((a, b) => b.trendPct - a.trendPct);

    coverageBySource.sort((a, b) => b.unlinkedProducts - a.unlinkedProducts || b.missingPrices - a.missingPrices);

    const canonicals = await ctx.db.query("canonicalProducts").collect();
    const canonicalLinkStats = new Map<
      Id<"canonicalProducts">,
      {
        linkCount: number;
        firstLinkedAt: number;
        lastLinkedAt: number;
      }
    >();
    for (const link of links) {
      const key = link.canonicalId;
      const entry = canonicalLinkStats.get(key);
      if (!entry) {
        canonicalLinkStats.set(key, {
          linkCount: 1,
          firstLinkedAt: link.createdAt,
          lastLinkedAt: link.createdAt
        });
      } else {
        entry.linkCount += 1;
        entry.firstLinkedAt = Math.min(entry.firstLinkedAt, link.createdAt);
        entry.lastLinkedAt = Math.max(entry.lastLinkedAt, link.createdAt);
      }
    }

    const canonicalGaps: CanonicalCoverageGap[] = canonicals
      .map((c) => {
        const key = c._id as unknown as string;
        const stats = canonicalLinkStats.get(key);
        const linkCount = stats?.linkCount ?? 0;
        return {
          canonicalId: key,
          name: c.name,
          createdAt: c.createdAt,
          linkCount,
          firstLinkedAt: stats ? stats.firstLinkedAt : null,
          lastLinkedAt: stats ? stats.lastLinkedAt : null
        };
      })
      .filter((c) => c.linkCount <= 1)
      .sort((a, b) => a.linkCount - b.linkCount || b.createdAt - a.createdAt)
      .slice(0, 8);

    return {
      generatedAt: now,
      summary: {
        recentDrops: dropCount,
        recentSpikes: spikeCount,
        newExtremes: newExtremesCount,
        outliers: outlierCount,
        staleSources: staleSources.length,
        recentFailures: recentFailures.length
      },
      movers: {
        drops: drops.slice(0, 8),
        spikes: spikes.slice(0, 6)
      },
      streakTrends: {
        sustainedDrops: sustainedDrops.slice(0, 6),
        sustainedRises: sustainedRises.slice(0, 6)
      },
      extremes: {
        newLows: newLows.slice(0, 6),
        newHighs: newHighs.slice(0, 6)
      },
      outliers: outliers.slice(0, 10),
      coverage: {
        sources: coverageBySource.slice(0, 8),
        canonicalGaps,
        totals: {
          unlinkedProducts: totalUnlinked,
          missingPrices: totalMissingPrices
        }
      },
      staleSources,
      recentFailures
    };
  }
});
