import { mutationGeneric, queryGeneric } from "convex/server";
import { v } from "convex/values";
import { requireSession } from "./authz";

const SCRAPER_CONCURRENCY_KEY = "scraperConcurrencyLimit";
const DEFAULT_SCRAPER_CONCURRENCY_LIMIT = 10;

function clampInt(n: number, min: number, max: number) {
  const value = Math.trunc(n);
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, value));
}

export const getScraperConcurrencyLimit = queryGeneric({
  args: { sessionToken: v.string() },
  handler: async (ctx, args) => {
    await requireSession(ctx, args.sessionToken);
    const row = await ctx.db
      .query("settings")
      .withIndex("by_key", (q) => q.eq("key", SCRAPER_CONCURRENCY_KEY))
      .unique();

    const raw = row?.value;
    if (typeof raw === "number" && Number.isFinite(raw) && raw >= 1) {
      return clampInt(raw, 1, 100);
    }
    return DEFAULT_SCRAPER_CONCURRENCY_LIMIT;
  }
});

export const setScraperConcurrencyLimit = mutationGeneric({
  args: { sessionToken: v.string(), limit: v.number() },
  handler: async (ctx, args) => {
    await requireSession(ctx, args.sessionToken);
    const limit = clampInt(args.limit, 1, 100);

    const existing = await ctx.db
      .query("settings")
      .withIndex("by_key", (q) => q.eq("key", SCRAPER_CONCURRENCY_KEY))
      .unique();

    const patch = { value: limit, updatedAt: Date.now() };
    if (existing) {
      await ctx.db.patch(existing._id, patch);
      return { ok: true, limit, created: false as const };
    }

    await ctx.db.insert("settings", { key: SCRAPER_CONCURRENCY_KEY, ...patch });
    return { ok: true, limit, created: true as const };
  }
});

