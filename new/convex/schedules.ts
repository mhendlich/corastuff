import { mutationGeneric, queryGeneric } from "convex/server";
import { v } from "convex/values";
import { requireSession } from "./authz";

export const list = queryGeneric({
  args: { sessionToken: v.string() },
  handler: async (ctx, args) => {
    await requireSession(ctx, args.sessionToken);
    return await ctx.db.query("schedules").collect();
  }
});

export const getBySourceSlug = queryGeneric({
  args: { sessionToken: v.string(), sourceSlug: v.string() },
  handler: async (ctx, args) => {
    await requireSession(ctx, args.sessionToken);
    const schedule = await ctx.db
      .query("schedules")
      .withIndex("by_sourceSlug", (q) => q.eq("sourceSlug", args.sourceSlug))
      .unique();
    return schedule ?? null;
  }
});

export const upsert = mutationGeneric({
  args: {
    sessionToken: v.string(),
    sourceSlug: v.string(),
    enabled: v.boolean(),
    intervalMinutes: v.number(),
    nextRunAt: v.optional(v.number())
  },
  handler: async (ctx, args) => {
    await requireSession(ctx, args.sessionToken);
    const sourceSlug = args.sourceSlug.trim();
    if (!sourceSlug) {
      throw new Error("sourceSlug is required");
    }
    if (!Number.isFinite(args.intervalMinutes) || args.intervalMinutes <= 0) {
      throw new Error("intervalMinutes must be a positive number");
    }

    const existing = await ctx.db
      .query("schedules")
      .withIndex("by_sourceSlug", (q) => q.eq("sourceSlug", sourceSlug))
      .unique();

    const patch = {
      enabled: args.enabled,
      intervalMinutes: args.intervalMinutes,
      nextRunAt: args.nextRunAt,
      updatedAt: Date.now()
    };

    if (existing) {
      await ctx.db.patch(existing._id, patch);
      return { id: existing._id, created: false };
    }

    const id = await ctx.db.insert("schedules", {
      sourceSlug,
      ...patch
    });
    return { id, created: true };
  }
});

export const setNextRunAt = mutationGeneric({
  args: {
    sessionToken: v.string(),
    sourceSlug: v.string(),
    nextRunAt: v.number()
  },
  handler: async (ctx, args) => {
    await requireSession(ctx, args.sessionToken);
    const sourceSlug = args.sourceSlug.trim();
    if (!sourceSlug) {
      throw new Error("sourceSlug is required");
    }
    if (!Number.isFinite(args.nextRunAt) || args.nextRunAt <= 0) {
      throw new Error("nextRunAt must be a positive timestamp");
    }

    const existing = await ctx.db
      .query("schedules")
      .withIndex("by_sourceSlug", (q) => q.eq("sourceSlug", sourceSlug))
      .unique();

    if (!existing) {
      return { ok: true, updated: false };
    }

    await ctx.db.patch(existing._id, { nextRunAt: args.nextRunAt, updatedAt: Date.now() });
    return { ok: true, updated: true };
  }
});
