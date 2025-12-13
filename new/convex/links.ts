import { mutationGeneric, queryGeneric } from "convex/server";
import { v } from "convex/values";
import { requireSession } from "./authz";

type LinkCounts = {
  sourceSlug: string;
  totalProducts: number;
  linked: number;
  unlinked: number;
  truncated: boolean;
};

async function getLatestRunIdForSource(ctx: any, sourceSlug: string) {
  const source = await ctx.db.query("sources").withIndex("by_slug", (q: any) => q.eq("slug", sourceSlug)).unique();
  return source?.lastSuccessfulRunId ?? null;
}

export const getForProduct = queryGeneric({
  args: {
    sessionToken: v.string(),
    sourceSlug: v.string(),
    itemId: v.string()
  },
  handler: async (ctx, args) => {
    await requireSession(ctx, args.sessionToken);
    const sourceSlug = args.sourceSlug.trim();
    const itemId = args.itemId.trim();
    if (!sourceSlug) throw new Error("sourceSlug is required");
    if (!itemId) throw new Error("itemId is required");

    const link = await ctx.db
      .query("productLinks")
      .withIndex("by_source_item", (q) => q.eq("sourceSlug", sourceSlug).eq("itemId", itemId))
      .unique();

    if (!link) return null;
    const canonical = await ctx.db.get(link.canonicalId);
    return { link, canonical };
  }
});

export const countsBySource = queryGeneric({
  args: {
    sessionToken: v.string(),
    sourceSlugs: v.array(v.string())
  },
  handler: async (ctx, args): Promise<LinkCounts[]> => {
    await requireSession(ctx, args.sessionToken);
    const sourceSlugs = Array.from(new Set(args.sourceSlugs.map((s) => s.trim()).filter(Boolean))).slice(
      0,
      50
    );

    const results: LinkCounts[] = [];
    for (const sourceSlug of sourceSlugs) {
      const latestRunId = await getLatestRunIdForSource(ctx, sourceSlug);
      const products = await ctx.db
        .query("productsLatest")
        .withIndex(
          latestRunId ? "by_source_run_lastSeenAt" : "by_sourceSlug_lastSeenAt",
          (q) =>
            latestRunId
              ? q.eq("sourceSlug", sourceSlug).eq("lastSeenRunId", latestRunId)
              : q.eq("sourceSlug", sourceSlug)
        )
        .collect();
      const links = await ctx.db
        .query("productLinks")
        .withIndex("by_source_item", (q) => q.eq("sourceSlug", sourceSlug))
        .collect();

      const linkedItemIds = new Set<string>(links.map((l) => l.itemId));
      let linked = 0;
      for (const p of products) {
        if (linkedItemIds.has(p.itemId)) linked += 1;
      }
      const unlinked = products.length - linked;
      results.push({
        sourceSlug,
        totalProducts: products.length,
        linked,
        unlinked,
        truncated: false
      });
    }
    return results;
  }
});

export const listUnlinked = queryGeneric({
  args: {
    sessionToken: v.string(),
    sourceSlug: v.string(),
    limit: v.optional(v.number()),
    q: v.optional(v.string())
  },
  handler: async (ctx, args) => {
    await requireSession(ctx, args.sessionToken);
    const sourceSlug = args.sourceSlug.trim();
    if (!sourceSlug) throw new Error("sourceSlug is required");

    const limit = Math.min(Math.max(args.limit ?? 60, 1), 200);
    const q = (args.q ?? "").trim().toLowerCase();

    const links = await ctx.db
      .query("productLinks")
      .withIndex("by_source_item", (q2) => q2.eq("sourceSlug", sourceSlug))
      .collect();
    const linkedItemIds = new Set<string>(links.map((l) => l.itemId));

    const latestRunId = await getLatestRunIdForSource(ctx, sourceSlug);
    const scan = Math.max(500, Math.min(limit * 40, 2000));
    const candidates = await ctx.db
      .query("productsLatest")
      .withIndex(
        latestRunId ? "by_source_run_lastSeenAt" : "by_sourceSlug_lastSeenAt",
        (q2) =>
          latestRunId
            ? q2.eq("sourceSlug", sourceSlug).eq("lastSeenRunId", latestRunId)
            : q2.eq("sourceSlug", sourceSlug)
      )
      .order("desc")
      .take(scan);

    const out: any[] = [];
    for (const p of candidates) {
      if (linkedItemIds.has(p.itemId)) continue;
      if (q) {
        const hay = `${p.name ?? ""} ${p.itemId ?? ""}`.toLowerCase();
        if (!hay.includes(q)) continue;
      }
      out.push(p);
      if (out.length >= limit) break;
    }
    return out;
  }
});

export const link = mutationGeneric({
  args: {
    sessionToken: v.string(),
    canonicalId: v.id("canonicalProducts"),
    sourceSlug: v.string(),
    itemId: v.string()
  },
  handler: async (ctx, args) => {
    await requireSession(ctx, args.sessionToken);
    const sourceSlug = args.sourceSlug.trim();
    const itemId = args.itemId.trim();
    if (!sourceSlug) throw new Error("sourceSlug is required");
    if (!itemId) throw new Error("itemId is required");

    const existing = await ctx.db
      .query("productLinks")
      .withIndex("by_source_item", (q) => q.eq("sourceSlug", sourceSlug).eq("itemId", itemId))
      .unique();

    if (existing) {
      if (existing.canonicalId !== args.canonicalId) {
        await ctx.db.patch(existing._id, { canonicalId: args.canonicalId });
        return { ok: true, id: existing._id, created: false, changed: true };
      }
      return { ok: true, id: existing._id, created: false, changed: false };
    }

    const id = await ctx.db.insert("productLinks", {
      canonicalId: args.canonicalId,
      sourceSlug,
      itemId,
      createdAt: Date.now()
    });
    return { ok: true, id, created: true, changed: false };
  }
});

export const unlink = mutationGeneric({
  args: {
    sessionToken: v.string(),
    sourceSlug: v.string(),
    itemId: v.string()
  },
  handler: async (ctx, args) => {
    await requireSession(ctx, args.sessionToken);
    const sourceSlug = args.sourceSlug.trim();
    const itemId = args.itemId.trim();
    if (!sourceSlug) throw new Error("sourceSlug is required");
    if (!itemId) throw new Error("itemId is required");

    const existing = await ctx.db
      .query("productLinks")
      .withIndex("by_source_item", (q) => q.eq("sourceSlug", sourceSlug).eq("itemId", itemId))
      .unique();

    if (!existing) return { ok: true, deleted: false };
    await ctx.db.delete(existing._id);
    return { ok: true, deleted: true };
  }
});

export const createCanonicalAndLink = mutationGeneric({
  args: {
    sessionToken: v.string(),
    sourceSlug: v.string(),
    itemId: v.string(),
    name: v.string(),
    description: v.optional(v.string())
  },
  handler: async (ctx, args) => {
    await requireSession(ctx, args.sessionToken);
    const sourceSlug = args.sourceSlug.trim();
    const itemId = args.itemId.trim();
    if (!sourceSlug) throw new Error("sourceSlug is required");
    if (!itemId) throw new Error("itemId is required");

    const name = args.name.trim();
    if (!name) throw new Error("name is required");
    const description = (args.description ?? "").trim() || undefined;

    const now = Date.now();
    const canonicalId = await ctx.db.insert("canonicalProducts", {
      name,
      description,
      createdAt: now,
      updatedAt: now
    });

    const existing = await ctx.db
      .query("productLinks")
      .withIndex("by_source_item", (q) => q.eq("sourceSlug", sourceSlug).eq("itemId", itemId))
      .unique();

    if (existing) {
      await ctx.db.patch(existing._id, { canonicalId });
      return { ok: true, canonicalId, linkId: existing._id, createdCanonical: true, createdLink: false };
    }

    const linkId = await ctx.db.insert("productLinks", {
      canonicalId,
      sourceSlug,
      itemId,
      createdAt: now
    });

    return { ok: true, canonicalId, linkId, createdCanonical: true, createdLink: true };
  }
});
