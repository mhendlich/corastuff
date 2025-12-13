import { mutationGeneric, queryGeneric } from "convex/server";
import { v } from "convex/values";
import { requireSession } from "./authz";

const CURRENT_KEY = "current";

export const getCurrent = queryGeneric({
  args: { sessionToken: v.string() },
  handler: async (ctx, args) => {
    await requireSession(ctx, args.sessionToken);
    const doc = await ctx.db
      .query("scraperBuilderJobs")
      .withIndex("by_key", (q) => q.eq("key", CURRENT_KEY))
      .unique();
    return doc ?? null;
  }
});

export const upsertCurrent = mutationGeneric({
  args: { sessionToken: v.string(), draft: v.any(), runId: v.optional(v.id("runs")) },
  handler: async (ctx, args) => {
    await requireSession(ctx, args.sessionToken);
    const now = Date.now();

    const existing = await ctx.db
      .query("scraperBuilderJobs")
      .withIndex("by_key", (q) => q.eq("key", CURRENT_KEY))
      .unique();

    if (existing) {
      await ctx.db.patch(existing._id, {
        draft: args.draft,
        ...(args.runId ? { runId: args.runId } : {}),
        updatedAt: now
      });
      return { ok: true, created: false };
    }

    await ctx.db.insert("scraperBuilderJobs", {
      key: CURRENT_KEY,
      draft: args.draft,
      ...(args.runId ? { runId: args.runId } : {}),
      createdAt: now,
      updatedAt: now
    });
    return { ok: true, created: true };
  }
});

export const clearCurrent = mutationGeneric({
  args: { sessionToken: v.string() },
  handler: async (ctx, args) => {
    await requireSession(ctx, args.sessionToken);
    const existing = await ctx.db
      .query("scraperBuilderJobs")
      .withIndex("by_key", (q) => q.eq("key", CURRENT_KEY))
      .unique();
    if (existing) {
      await ctx.db.delete(existing._id);
    }
    return { ok: true };
  }
});

