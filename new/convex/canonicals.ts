import { mutationGeneric, queryGeneric } from "convex/server";
import { v } from "convex/values";
import { requireSession } from "./authz";

export const list = queryGeneric({
  args: {
    sessionToken: v.string(),
    limit: v.optional(v.number()),
    q: v.optional(v.string())
  },
  handler: async (ctx, args) => {
    await requireSession(ctx, args.sessionToken);
    const limit = Math.min(Math.max(args.limit ?? 50, 1), 200);
    const q = (args.q ?? "").trim().toLowerCase();

    const base = await ctx.db.query("canonicalProducts").order("desc").take(q ? 200 : limit);
    if (!q) return base.slice(0, limit);

    return base
      .filter((c) => c.name.toLowerCase().includes(q))
      .slice(0, limit);
  }
});

export const create = mutationGeneric({
  args: {
    sessionToken: v.string(),
    name: v.string(),
    description: v.optional(v.string())
  },
  handler: async (ctx, args) => {
    await requireSession(ctx, args.sessionToken);
    const name = args.name.trim();
    if (!name) throw new Error("name is required");
    const description = (args.description ?? "").trim() || undefined;
    const now = Date.now();
    const id = await ctx.db.insert("canonicalProducts", {
      name,
      description,
      createdAt: now,
      updatedAt: now
    });
    return { id };
  }
});
