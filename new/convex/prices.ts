import { queryGeneric } from "convex/server";
import { v } from "convex/values";
import { requireSession } from "./authz";

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

    const limit = Math.min(Math.max(args.limit ?? 50, 1), 500);
    return await ctx.db
      .query("pricePoints")
      .withIndex("by_source_item_ts", (q) => q.eq("sourceSlug", sourceSlug).eq("itemId", itemId))
      .order("desc")
      .take(limit);
  }
});
