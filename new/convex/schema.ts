import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

export default defineSchema({
  authSessions: defineTable({
    token: v.string(),
    kind: v.union(v.literal("user"), v.literal("service")),
    label: v.optional(v.string()),
    createdAt: v.number(),
    expiresAt: v.number(),
    revokedAt: v.optional(v.number())
  })
    .index("by_token", ["token"])
    .index("by_expiresAt", ["expiresAt"]),

  sources: defineTable({
    slug: v.string(),
    displayName: v.string(),
    enabled: v.boolean(),
    type: v.union(v.literal("http"), v.literal("playwright"), v.literal("hybrid")),
    config: v.any(),
    lastSuccessfulRunId: v.optional(v.id("runs")),
    lastSuccessfulAt: v.optional(v.number())
  }).index("by_slug", ["slug"]),

  schedules: defineTable({
    sourceSlug: v.string(),
    enabled: v.boolean(),
    intervalMinutes: v.number(),
    nextRunAt: v.optional(v.number()),
    updatedAt: v.number()
  }).index("by_sourceSlug", ["sourceSlug"]),

  runs: defineTable({
    sourceSlug: v.string(),
    status: v.union(
      v.literal("pending"),
      v.literal("running"),
      v.literal("completed"),
      v.literal("failed"),
      v.literal("canceled")
    ),
    requestedBy: v.optional(v.string()),
    startedAt: v.optional(v.number()),
    completedAt: v.optional(v.number()),
    productsFound: v.optional(v.number()),
    missingItemIds: v.optional(v.number()),
    error: v.optional(v.string()),
    cancelRequested: v.optional(v.boolean()),
    job: v.optional(v.any())
  })
    .index("by_sourceSlug", ["sourceSlug"])
    .index("by_status", ["status"]),

  runEvents: defineTable({
    runId: v.id("runs"),
    ts: v.number(),
    level: v.union(v.literal("debug"), v.literal("info"), v.literal("warn"), v.literal("error")),
    type: v.union(v.literal("log"), v.literal("progress"), v.literal("metric"), v.literal("checkpoint")),
    payload: v.any()
  }).index("by_runId_ts", ["runId", "ts"]),

  runArtifacts: defineTable({
    runId: v.id("runs"),
    key: v.string(),
    type: v.union(
      v.literal("log"),
      v.literal("json"),
      v.literal("html"),
      v.literal("screenshot"),
      v.literal("other")
    ),
    path: v.string(),
    createdAt: v.number(),
    updatedAt: v.number()
  })
    .index("by_runId", ["runId"])
    .index("by_runId_key", ["runId", "key"]),

  productsLatest: defineTable({
    sourceSlug: v.string(),
    itemId: v.string(),
    name: v.string(),
    url: v.optional(v.string()),
    currency: v.optional(v.union(v.string(), v.null())),
    lastPrice: v.optional(v.union(v.number(), v.null())),
    prevPrice: v.optional(v.number()),
    prevPriceAt: v.optional(v.number()),
    priceChange: v.optional(v.number()),
    priceChangePct: v.optional(v.number()),
    streakKind: v.optional(v.union(v.literal("drop"), v.literal("rise"), v.null())),
    streakTrendPct: v.optional(v.union(v.number(), v.null())),
    streakPrices: v.optional(v.union(v.array(v.number()), v.null())),
    firstSeenAt: v.optional(v.number()),
    minPrice: v.optional(v.number()),
    maxPrice: v.optional(v.number()),
    minPrevPrice: v.optional(v.number()),
    maxPrevPrice: v.optional(v.number()),
    lastSeenAt: v.number(),
    lastSeenRunId: v.optional(v.id("runs")),
    image: v.optional(
      v.object({
        hash: v.string(),
        mime: v.string(),
        bytes: v.number(),
        path: v.string(),
        mediaUrl: v.string()
      })
    ),
    updatedAt: v.number()
  })
    .index("by_source_item", ["sourceSlug", "itemId"])
    .index("by_source_run_lastSeenAt", ["sourceSlug", "lastSeenRunId", "lastSeenAt"])
    .index("by_sourceSlug_lastSeenAt", ["sourceSlug", "lastSeenAt"]),

  pricePoints: defineTable({
    sourceSlug: v.string(),
    itemId: v.string(),
    ts: v.number(),
    price: v.number(),
    currency: v.string(),
    runId: v.optional(v.id("runs"))
  }).index("by_source_item_ts", ["sourceSlug", "itemId", "ts"]),

  scraperBuilderJobs: defineTable({
    key: v.string(),
    draft: v.optional(v.any()),
    runId: v.optional(v.id("runs")),
    createdAt: v.number(),
    updatedAt: v.number()
  }).index("by_key", ["key"]),

  canonicalProducts: defineTable({
    name: v.string(),
    description: v.optional(v.string()),
    createdAt: v.number(),
    updatedAt: v.number()
  }),

  productLinks: defineTable({
    canonicalId: v.id("canonicalProducts"),
    sourceSlug: v.string(),
    itemId: v.string(),
    createdAt: v.number()
  })
    .index("by_source_item", ["sourceSlug", "itemId"])
    .index("by_canonical", ["canonicalId"])
});
