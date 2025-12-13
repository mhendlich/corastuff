import { mutationGeneric, queryGeneric } from "convex/server";
import { v } from "convex/values";
import { requireSession } from "./authz";

const sourceType = v.union(v.literal("http"), v.literal("playwright"), v.literal("hybrid"));

export const list = queryGeneric({
  args: { sessionToken: v.string() },
  handler: async (ctx, args) => {
    await requireSession(ctx, args.sessionToken);
    return await ctx.db.query("sources").withIndex("by_slug").collect();
  }
});

export const getBySlug = queryGeneric({
  args: { sessionToken: v.string(), slug: v.string() },
  handler: async (ctx, args) => {
    await requireSession(ctx, args.sessionToken);
    const slug = args.slug.trim();
    if (!slug) return null;
    const source = await ctx.db.query("sources").withIndex("by_slug", (q) => q.eq("slug", slug)).unique();
    return source ?? null;
  }
});

export const upsert = mutationGeneric({
  args: {
    sessionToken: v.string(),
    slug: v.string(),
    displayName: v.string(),
    enabled: v.boolean(),
    type: sourceType,
    config: v.any()
  },
  handler: async (ctx, args) => {
    await requireSession(ctx, args.sessionToken);
    const existing = await ctx.db
      .query("sources")
      .withIndex("by_slug", (q) => q.eq("slug", args.slug))
      .unique();

    if (existing) {
      await ctx.db.patch(existing._id, {
        displayName: args.displayName,
        enabled: args.enabled,
        type: args.type,
        config: args.config
      });
      return { id: existing._id, created: false };
    }

    const id = await ctx.db.insert("sources", {
      slug: args.slug,
      displayName: args.displayName,
      enabled: args.enabled,
      type: args.type,
      config: args.config
    });
    return { id, created: true };
  }
});

export const setEnabled = mutationGeneric({
  args: { sessionToken: v.string(), slug: v.string(), enabled: v.boolean() },
  handler: async (ctx, args) => {
    await requireSession(ctx, args.sessionToken);
    const existing = await ctx.db
      .query("sources")
      .withIndex("by_slug", (q) => q.eq("slug", args.slug))
      .unique();

    if (!existing) {
      throw new Error(`Unknown source slug: ${args.slug}`);
    }

    await ctx.db.patch(existing._id, { enabled: args.enabled });
    return { ok: true };
  }
});

export const seedDemo = mutationGeneric({
  args: { sessionToken: v.string() },
  handler: async (ctx, args) => {
    await requireSession(ctx, args.sessionToken);
    const demo = [
      {
        slug: "cardiofitness",
        displayName: "Cardiofitness (Shopify demo)",
        enabled: true,
        type: "http" as const,
        config: {
          baseUrl: "https://www.cardiofitness.de/",
          sourceUrl: "https://www.cardiofitness.de/collections/blackroll",
          collectionProductsJsonUrl: "https://www.cardiofitness.de/collections/blackroll/products.json",
          currency: "EUR"
        }
      },
      {
        slug: "dein_vital_shop",
        displayName: "Dein-Vital (Shopify demo)",
        enabled: false,
        type: "http" as const,
        config: {
          baseUrl: "https://dein-vital.shop/",
          sourceUrl: "https://dein-vital.shop/collections/blackroll/blackroll",
          collectionProductsJsonUrl: "https://dein-vital.shop/collections/blackroll/products.json",
          currency: "EUR"
        }
      },
      {
        slug: "bodyguard_shop",
        displayName: "Bodyguard-shop (Shopify demo)",
        enabled: false,
        type: "http" as const,
        config: {
          baseUrl: "https://bodyguard-shop.ch/",
          sourceUrl: "https://bodyguard-shop.ch/en/collections/blackroll",
          collectionProductsJsonUrl: "https://bodyguard-shop.ch/en/collections/blackroll/products.json",
          productPathPrefix: "/en/products/",
          currency: "CHF"
        }
      },
      {
        slug: "medidor",
        displayName: "MEDiDOR (Shopify vendor demo)",
        enabled: false,
        type: "http" as const,
        config: {
          baseUrl: "https://medidor.ch/",
          sourceUrl: "https://medidor.ch/en/collections/vendors?q=blackroll",
          vendorListingUrl: "https://medidor.ch/en/collections/vendors?q=blackroll",
          productPathPrefix: "/en/products/",
          currency: "CHF"
        }
      },
      {
        slug: "digitec",
        displayName: "Digitec (demo)",
        enabled: false,
        type: "playwright" as const,
        config: { baseUrl: "https://www.digitec.ch/" }
      },
      {
        slug: "galaxus",
        displayName: "Galaxus (demo)",
        enabled: false,
        type: "playwright" as const,
        config: { baseUrl: "https://www.galaxus.ch/" }
      },
      {
        slug: "globetrotter",
        displayName: "Globetrotter (Playwright demo)",
        enabled: false,
        type: "playwright" as const,
        config: {
          baseUrl: "https://www.globetrotter.de/",
          listingUrl: "https://www.globetrotter.de/marken/blackroll/",
          currency: "EUR"
        }
      }
    ];

    let inserted = 0;
    let updated = 0;
    for (const s of demo) {
      const existing = await ctx.db.query("sources").withIndex("by_slug", (q) => q.eq("slug", s.slug)).unique();
      if (existing) {
        if (
          typeof existing.config === "object" &&
          existing.config !== null &&
          !Array.isArray(existing.config) &&
          typeof s.config === "object" &&
          s.config !== null &&
          !Array.isArray(s.config)
        ) {
          const merged = { ...(s.config as Record<string, unknown>), ...(existing.config as Record<string, unknown>) };
          if (JSON.stringify(merged) !== JSON.stringify(existing.config)) {
            await ctx.db.patch(existing._id, { config: merged });
            updated += 1;
          }
        }
        continue;
      }

      await ctx.db.insert("sources", s);
      inserted += 1;
    }
    return { inserted, updated };
  }
});
