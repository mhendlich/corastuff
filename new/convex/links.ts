import { mutationGeneric, queryGeneric } from "convex/server";
import { v } from "convex/values";
import { requireSession } from "./authz";

type LinkCounts = {
  sourceSlug: string;
  totalProducts: number;
  linked: number;
  unlinked: number;
  missingItemIds: number;
  truncated: boolean;
};

type UnlinkedPage = {
  items: any[];
  offset: number;
  limit: number;
  hasMore: boolean;
  truncated: boolean;
};

async function getLatestRunIdForSource(ctx: any, sourceSlug: string) {
  const source = await ctx.db.query("sources").withIndex("by_slug", (q: any) => q.eq("slug", sourceSlug)).unique();
  return source?.lastSuccessfulRunId ?? null;
}

function normalizeText(s: string) {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function tokenSet(s: string) {
  const tokens = normalizeText(s)
    .split(" ")
    .map((t) => t.trim())
    .filter((t) => t.length >= 3)
    .slice(0, 24);
  return new Set(tokens);
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

export const getUnlinkedByKeys = queryGeneric({
  args: {
    sessionToken: v.string(),
    keys: v.array(
      v.object({
        sourceSlug: v.string(),
        itemId: v.string()
      })
    )
  },
  handler: async (ctx, args) => {
    await requireSession(ctx, args.sessionToken);
    const rawKeys = args.keys.slice(0, 250);
    if (rawKeys.length !== args.keys.length) throw new Error("Too many keys (max 250)");

    const seen = new Set<string>();
    const keys = rawKeys
      .map((k) => ({ sourceSlug: k.sourceSlug.trim(), itemId: k.itemId.trim() }))
      .filter((k) => k.sourceSlug && k.itemId)
      .filter((k) => {
        const id = `${k.sourceSlug}:${k.itemId}`;
        if (seen.has(id)) return false;
        seen.add(id);
        return true;
      });

    const out: any[] = [];
    for (const { sourceSlug, itemId } of keys) {
      const existingLink = await ctx.db
        .query("productLinks")
        .withIndex("by_source_item", (q) => q.eq("sourceSlug", sourceSlug).eq("itemId", itemId))
        .unique();
      if (existingLink) continue;

      const latestRunId = await getLatestRunIdForSource(ctx, sourceSlug);
      const product = await ctx.db
        .query("productsLatest")
        .withIndex("by_source_item", (q) => q.eq("sourceSlug", sourceSlug).eq("itemId", itemId))
        .unique();
      if (!product) continue;
      if (latestRunId && product.lastSeenRunId !== latestRunId) continue;
      out.push(product);
    }

    return out;
  }
});

export const countsBySource = queryGeneric({
  args: {
    sessionToken: v.string(),
    sourceSlugs: v.array(v.string()),
    nonce: v.optional(v.number())
  },
  handler: async (ctx, args): Promise<LinkCounts[]> => {
    await requireSession(ctx, args.sessionToken);
    void args.nonce;
    const sourceSlugs = Array.from(new Set(args.sourceSlugs.map((s) => s.trim()).filter(Boolean))).slice(
      0,
      50
    );

    const results: LinkCounts[] = [];
    for (const sourceSlug of sourceSlugs) {
      const latestRunId = await getLatestRunIdForSource(ctx, sourceSlug);
      const run = latestRunId ? await ctx.db.get(latestRunId) : null;
      const missingItemIds = typeof run?.missingItemIds === "number" ? run.missingItemIds : 0;
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
        missingItemIds,
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
    q: v.optional(v.string()),
    nonce: v.optional(v.number())
  },
  handler: async (ctx, args) => {
    await requireSession(ctx, args.sessionToken);
    void args.nonce;
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

export const listUnlinkedPage = queryGeneric({
  args: {
    sessionToken: v.string(),
    sourceSlugs: v.array(v.string()),
    offset: v.optional(v.number()),
    limit: v.optional(v.number()),
    q: v.optional(v.string()),
    nonce: v.optional(v.number())
  },
  handler: async (ctx, args): Promise<UnlinkedPage> => {
    await requireSession(ctx, args.sessionToken);
    void args.nonce;

    const rawSourceSlugs = Array.from(new Set(args.sourceSlugs.map((s) => s.trim()).filter(Boolean)));
    const sourceSlugs = rawSourceSlugs.slice(0, 20);
    if (sourceSlugs.length === 0) {
      return { items: [], offset: 0, limit: 0, hasMore: false, truncated: false };
    }
    if (rawSourceSlugs.length > sourceSlugs.length) {
      throw new Error(`Too many sourceSlugs (max ${sourceSlugs.length})`);
    }

    const offset = Math.min(Math.max(args.offset ?? 0, 0), 50_000);
    const limit = Math.min(Math.max(args.limit ?? 60, 1), 200);
    const q = (args.q ?? "").trim().toLowerCase();

    const need = offset + limit;
    const scanPerSource = Math.max(400, Math.min(need * 25, 2500));

    const all: any[] = [];
    let truncated = false;

    for (const sourceSlug of sourceSlugs) {
      const links = await ctx.db
        .query("productLinks")
        .withIndex("by_source_item", (q2) => q2.eq("sourceSlug", sourceSlug))
        .collect();
      const linkedItemIds = new Set<string>(links.map((l) => l.itemId));

      const latestRunId = await getLatestRunIdForSource(ctx, sourceSlug);
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
        .take(scanPerSource);

      if (candidates.length >= scanPerSource) truncated = true;

      for (const p of candidates) {
        if (linkedItemIds.has(p.itemId)) continue;
        if (q) {
          const hay = `${p.name ?? ""} ${p.itemId ?? ""}`.toLowerCase();
          if (!hay.includes(q)) continue;
        }
        all.push(p);
      }
    }

    all.sort((a, b) => {
      const at = typeof a.lastSeenAt === "number" ? a.lastSeenAt : 0;
      const bt = typeof b.lastSeenAt === "number" ? b.lastSeenAt : 0;
      if (bt !== at) return bt - at;
      const as = `${a.sourceSlug ?? ""}:${a.itemId ?? ""}`;
      const bs = `${b.sourceSlug ?? ""}:${b.itemId ?? ""}`;
      return as.localeCompare(bs);
    });

    const items = all.slice(offset, offset + limit);
    return {
      items,
      offset,
      limit,
      hasMore: offset + limit < all.length,
      truncated
    };
  }
});

export const suggestCanonicalsForProduct = queryGeneric({
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

    const limit = Math.min(Math.max(args.limit ?? 6, 1), 12);

    const product = await ctx.db
      .query("productsLatest")
      .withIndex("by_source_item", (q) => q.eq("sourceSlug", sourceSlug).eq("itemId", itemId))
      .unique();
    if (!product) return [];

    const productText = `${product.name ?? ""} ${product.itemId ?? ""}`.trim();
    const productTokens = tokenSet(productText);
    if (productTokens.size === 0) return [];

    const candidates = await ctx.db.query("canonicalProducts").order("desc").take(300);

    const scored: Array<{ canonical: any; score: number; reason: string }> = [];

    for (const canonical of candidates) {
      const canonicalText = `${canonical.name ?? ""} ${canonical.description ?? ""}`.trim();
      const canonicalTokens = tokenSet(canonicalText);
      if (canonicalTokens.size === 0) continue;

      const shared: string[] = [];
      for (const t of productTokens) {
        if (canonicalTokens.has(t)) shared.push(t);
      }

      let score = shared.length;
      const productNorm = normalizeText(product.name ?? "");
      const canonicalNorm = normalizeText(canonical.name ?? "");
      if (productNorm && canonicalNorm.includes(productNorm)) score += 4;
      if (shared.length === 0 && score === 0) continue;

      score += Math.min(2, Math.floor(shared.length / 3));

      scored.push({
        canonical,
        score,
        reason: shared.length > 0 ? `shared tokens: ${shared.slice(0, 5).join(", ")}` : "name similarity"
      });
    }

    scored.sort((a, b) => b.score - a.score || (a.canonical.name ?? "").localeCompare(b.canonical.name ?? ""));
    return scored.slice(0, limit);
  }
});

export const smartSuggestions = queryGeneric({
  args: {
    sessionToken: v.string(),
    sourceSlugs: v.array(v.string()),
    limit: v.optional(v.number()),
    nonce: v.optional(v.number())
  },
  handler: async (ctx, args) => {
    await requireSession(ctx, args.sessionToken);
    void args.nonce;

    const limit = Math.min(Math.max(args.limit ?? 18, 1), 40);
    const rawSourceSlugs = Array.from(new Set(args.sourceSlugs.map((s) => s.trim()).filter(Boolean)));
    const sourceSlugs = rawSourceSlugs.slice(0, 20);
    if (sourceSlugs.length === 0) return [];
    if (rawSourceSlugs.length > sourceSlugs.length) throw new Error(`Too many sourceSlugs (max ${sourceSlugs.length})`);

    const canonicals = await ctx.db.query("canonicalProducts").order("desc").take(300);
    const canonicalIndex = canonicals.map((canonical) => ({
      canonical,
      tokens: tokenSet(`${canonical.name ?? ""} ${canonical.description ?? ""}`),
      normName: normalizeText(canonical.name ?? "")
    }));

    const matchesByCanonicalId = new Map<
      string,
      {
        canonical: any;
        totalScore: number;
        items: Array<{
          product: any;
          score: number;
          reason: string;
          key: string;
        }>;
      }
    >();

    for (const sourceSlug of sourceSlugs) {
      const links = await ctx.db
        .query("productLinks")
        .withIndex("by_source_item", (q2) => q2.eq("sourceSlug", sourceSlug))
        .collect();
      const linkedItemIds = new Set<string>(links.map((l) => l.itemId));

      const latestRunId = await getLatestRunIdForSource(ctx, sourceSlug);
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
        .take(1200);

      let kept = 0;
      for (const product of candidates) {
        if (linkedItemIds.has(product.itemId)) continue;
        const productText = `${product.name ?? ""} ${product.itemId ?? ""}`.trim();
        const productTokens = tokenSet(productText);
        if (productTokens.size === 0) continue;

        const productNormName = normalizeText(product.name ?? "");

        let best: { canonical: any; score: number; reason: string } | null = null;
        for (const entry of canonicalIndex) {
          if (entry.tokens.size === 0) continue;
          let shared = 0;
          const sharedTokens: string[] = [];
          for (const t of productTokens) {
            if (entry.tokens.has(t)) {
              shared += 1;
              if (sharedTokens.length < 4) sharedTokens.push(t);
            }
          }
          let score = shared;
          if (productNormName && entry.normName && entry.normName.includes(productNormName)) score += 4;
          if (score < 2) continue;
          const reason = sharedTokens.length > 0 ? `shared tokens: ${sharedTokens.join(", ")}` : "name similarity";
          if (!best || score > best.score) best = { canonical: entry.canonical, score, reason };
        }

        if (!best) continue;

        const canonicalId = best.canonical._id;
        const group = matchesByCanonicalId.get(canonicalId) ?? {
          canonical: best.canonical,
          totalScore: 0,
          items: []
        };
        const key = `${sourceSlug}:${product.itemId}`;
        if (!group.items.some((it) => it.key === key)) {
          group.items.push({ product, score: best.score, reason: best.reason, key });
          group.totalScore += best.score;
        }
        matchesByCanonicalId.set(canonicalId, group);

        kept += 1;
        if (kept >= 120) break;
      }
    }

    const groups = Array.from(matchesByCanonicalId.values())
      .map((g) => {
        g.items.sort((a, b) => b.score - a.score || (b.product.lastSeenAt ?? 0) - (a.product.lastSeenAt ?? 0));
        return {
          canonical: g.canonical,
          totalScore: g.totalScore,
          count: g.items.length,
          items: g.items.slice(0, 12).map((it) => ({
            sourceSlug: it.product.sourceSlug,
            itemId: it.product.itemId,
            name: it.product.name,
            image: it.product.image ?? null,
            lastPrice: typeof it.product.lastPrice === "number" ? it.product.lastPrice : null,
            currency: typeof it.product.currency === "string" ? it.product.currency : null,
            score: it.score,
            reason: it.reason
          }))
        };
      })
      .filter((g) => g.count > 0);

    groups.sort((a, b) => b.count - a.count || b.totalScore - a.totalScore);
    return groups.slice(0, limit);
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

export const bulkLink = mutationGeneric({
  args: {
    sessionToken: v.string(),
    canonicalId: v.id("canonicalProducts"),
    items: v.array(
      v.object({
        sourceSlug: v.string(),
        itemId: v.string()
      })
    )
  },
  handler: async (ctx, args) => {
    await requireSession(ctx, args.sessionToken);

    const canonical = await ctx.db.get(args.canonicalId);
    if (!canonical) throw new Error("canonical not found");

    const rawItems = args.items.slice(0, 250);
    if (rawItems.length !== args.items.length) throw new Error("Too many items (max 250)");

    const seen = new Set<string>();
    const items = rawItems
      .map((it) => ({ sourceSlug: it.sourceSlug.trim(), itemId: it.itemId.trim() }))
      .filter((it) => it.sourceSlug && it.itemId)
      .filter((it) => {
        const k = `${it.sourceSlug}:${it.itemId}`;
        if (seen.has(k)) return false;
        seen.add(k);
        return true;
      });

    let created = 0;
    let changed = 0;
    let unchanged = 0;
    let missing = 0;

    const processed: Array<{ sourceSlug: string; itemId: string }> = [];
    const missingKeys: Array<{ sourceSlug: string; itemId: string }> = [];

    const now = Date.now();
    for (const { sourceSlug, itemId } of items) {
      const product = await ctx.db
        .query("productsLatest")
        .withIndex("by_source_item", (q) => q.eq("sourceSlug", sourceSlug).eq("itemId", itemId))
        .unique();
      if (!product) {
        missing += 1;
        missingKeys.push({ sourceSlug, itemId });
        continue;
      }

      const existing = await ctx.db
        .query("productLinks")
        .withIndex("by_source_item", (q) => q.eq("sourceSlug", sourceSlug).eq("itemId", itemId))
        .unique();

      if (existing) {
        if (existing.canonicalId !== args.canonicalId) {
          await ctx.db.patch(existing._id, { canonicalId: args.canonicalId });
          changed += 1;
        } else {
          unchanged += 1;
        }
      } else {
        await ctx.db.insert("productLinks", {
          canonicalId: args.canonicalId,
          sourceSlug,
          itemId,
          createdAt: now
        });
        created += 1;
      }
      processed.push({ sourceSlug, itemId });
    }

    return {
      ok: true,
      canonicalId: args.canonicalId,
      requested: args.items.length,
      unique: items.length,
      created,
      changed,
      unchanged,
      missing,
      processed,
      missingKeys
    };
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
