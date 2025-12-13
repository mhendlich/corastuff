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
      .filter((c) => {
        const hay = `${c.name ?? ""} ${c.description ?? ""}`.toLowerCase();
        return hay.includes(q);
      })
      .slice(0, limit);
  }
});

export const listWithLinkInfo = queryGeneric({
  args: {
    sessionToken: v.string(),
    limit: v.optional(v.number()),
    q: v.optional(v.string())
  },
  handler: async (ctx, args) => {
    await requireSession(ctx, args.sessionToken);
    const limit = Math.min(Math.max(args.limit ?? 50, 1), 200);
    const q = (args.q ?? "").trim().toLowerCase();

    const sources = await ctx.db.query("sources").collect();
    const displayNameBySlug = new Map<string, string>(sources.map((s) => [s.slug, s.displayName]));

    const base = await ctx.db.query("canonicalProducts").order("desc").take(q ? 200 : limit);
    const canonicals = q
      ? base
          .filter((c) => {
            const hay = `${c.name ?? ""} ${c.description ?? ""}`.toLowerCase();
            return hay.includes(q);
          })
          .slice(0, limit)
      : base.slice(0, limit);

    const out: Array<{
      canonical: (typeof canonicals)[number];
      linkCount: number;
      sourcesPreview: Array<{ sourceSlug: string; displayName: string }>;
    }> = [];

    for (const canonical of canonicals) {
      const links = await ctx.db
        .query("productLinks")
        .withIndex("by_canonical", (q2) => q2.eq("canonicalId", canonical._id))
        .collect();
      const uniqueSlugs: string[] = [];
      const seen = new Set<string>();
      for (const link of links) {
        if (seen.has(link.sourceSlug)) continue;
        seen.add(link.sourceSlug);
        uniqueSlugs.push(link.sourceSlug);
      }

      out.push({
        canonical,
        linkCount: links.length,
        sourcesPreview: uniqueSlugs.slice(0, 4).map((sourceSlug) => ({
          sourceSlug,
          displayName: displayNameBySlug.get(sourceSlug) ?? sourceSlug
        }))
      });
    }

    return out;
  }
});

export const get = queryGeneric({
  args: {
    sessionToken: v.string(),
    canonicalId: v.id("canonicalProducts")
  },
  handler: async (ctx, args) => {
    await requireSession(ctx, args.sessionToken);
    return await ctx.db.get(args.canonicalId);
  }
});

export const detail = queryGeneric({
  args: {
    sessionToken: v.string(),
    canonicalId: v.id("canonicalProducts")
  },
  handler: async (ctx, args) => {
    await requireSession(ctx, args.sessionToken);
    const canonical = await ctx.db.get(args.canonicalId);
    if (!canonical) return null;

    const sources = await ctx.db.query("sources").collect();
    const sourceBySlug = new Map<string, (typeof sources)[number]>(sources.map((s) => [s.slug, s]));

    const links = await ctx.db
      .query("productLinks")
      .withIndex("by_canonical", (q) => q.eq("canonicalId", args.canonicalId))
      .collect();

    const linkedProducts: Array<{
      sourceSlug: string;
      sourceDisplayName: string;
      itemId: string;
      name: string | null;
      price: number | null;
      currency: string | null;
      url: string | null;
      lastSeenAt: number | null;
      seenInLatestRun: boolean;
    }> = [];

    let bestPrice: number | null = null;
    let bestKey: string | null = null;

    for (const link of links) {
      const product = await ctx.db
        .query("productsLatest")
        .withIndex("by_source_item", (q) => q.eq("sourceSlug", link.sourceSlug).eq("itemId", link.itemId))
        .unique();

      const source = sourceBySlug.get(link.sourceSlug);
      const seenInLatestRun =
        !!product && !!source?.lastSuccessfulRunId && product.lastSeenRunId === source.lastSuccessfulRunId;

      const price = typeof product?.lastPrice === "number" ? product!.lastPrice : null;
      if (price !== null && (bestPrice === null || price < bestPrice)) {
        bestPrice = price;
        bestKey = `${link.sourceSlug}:${link.itemId}`;
      }

      linkedProducts.push({
        sourceSlug: link.sourceSlug,
        sourceDisplayName: source?.displayName ?? link.sourceSlug,
        itemId: link.itemId,
        name: product?.name ?? null,
        price,
        currency: typeof product?.currency === "string" ? product.currency : null,
        url: typeof product?.url === "string" ? product.url : null,
        lastSeenAt: product?.lastSeenAt ?? null,
        seenInLatestRun
      });
    }

    linkedProducts.sort((a, b) => {
      if (a.price === null && b.price !== null) return 1;
      if (a.price !== null && b.price === null) return -1;
      if (a.price !== null && b.price !== null) return a.price - b.price;
      return a.sourceSlug.localeCompare(b.sourceSlug);
    });

    return { canonical, linkCount: links.length, bestKey, linkedProducts };
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

export const update = mutationGeneric({
  args: {
    sessionToken: v.string(),
    canonicalId: v.id("canonicalProducts"),
    name: v.string(),
    description: v.optional(v.string())
  },
  handler: async (ctx, args) => {
    await requireSession(ctx, args.sessionToken);
    const canonical = await ctx.db.get(args.canonicalId);
    if (!canonical) throw new Error("canonical not found");

    const name = args.name.trim();
    if (!name) throw new Error("name is required");
    const description = (args.description ?? "").trim() || undefined;
    await ctx.db.patch(args.canonicalId, { name, description, updatedAt: Date.now() });
    return { ok: true };
  }
});

export const remove = mutationGeneric({
  args: {
    sessionToken: v.string(),
    canonicalId: v.id("canonicalProducts")
  },
  handler: async (ctx, args) => {
    await requireSession(ctx, args.sessionToken);
    const canonical = await ctx.db.get(args.canonicalId);
    if (!canonical) throw new Error("canonical not found");

    const links = await ctx.db
      .query("productLinks")
      .withIndex("by_canonical", (q) => q.eq("canonicalId", args.canonicalId))
      .collect();
    for (const link of links) {
      await ctx.db.delete(link._id);
    }
    await ctx.db.delete(args.canonicalId);
    return { ok: true, deletedLinks: links.length };
  }
});
