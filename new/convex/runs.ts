import { mutationGeneric, queryGeneric } from "convex/server";
import { v } from "convex/values";
import { requireSession } from "./authz";

const runStatus = v.union(
  v.literal("pending"),
  v.literal("running"),
  v.literal("completed"),
  v.literal("failed"),
  v.literal("canceled")
);

const runLevel = v.union(v.literal("debug"), v.literal("info"), v.literal("warn"), v.literal("error"));
const runEventType = v.union(v.literal("log"), v.literal("progress"), v.literal("metric"), v.literal("checkpoint"));

export const listRecent = queryGeneric({
  args: {
    sessionToken: v.string(),
    limit: v.optional(v.number()),
    sourceSlug: v.optional(v.string())
  },
  handler: async (ctx, args) => {
    await requireSession(ctx, args.sessionToken);
    const limit = Math.min(Math.max(args.limit ?? 25, 1), 200);
    if (args.sourceSlug) {
      return await ctx.db
        .query("runs")
        .withIndex("by_sourceSlug", (q) => q.eq("sourceSlug", args.sourceSlug))
        .order("desc")
        .take(limit);
    }
    return await ctx.db.query("runs").order("desc").take(limit);
  }
});

export const listActive = queryGeneric({
  args: { sessionToken: v.string() },
  handler: async (ctx, args) => {
    await requireSession(ctx, args.sessionToken);
    const running = await ctx.db
      .query("runs")
      .withIndex("by_status", (q) => q.eq("status", "running"))
      .order("desc")
      .take(200);
    const pending = await ctx.db
      .query("runs")
      .withIndex("by_status", (q) => q.eq("status", "pending"))
      .order("desc")
      .take(200);

    return [...running, ...pending].sort((a, b) => b._creationTime - a._creationTime);
  }
});

export const getActiveBySource = queryGeneric({
  args: {
    sessionToken: v.string(),
    sourceSlug: v.string()
  },
  handler: async (ctx, args) => {
    await requireSession(ctx, args.sessionToken);
    const sourceSlug = args.sourceSlug.trim();
    if (!sourceSlug) return null;

    const recent = await ctx.db
      .query("runs")
      .withIndex("by_sourceSlug", (q) => q.eq("sourceSlug", sourceSlug))
      .order("desc")
      .take(25);

    const active = recent.find((r) => r.status === "pending" || r.status === "running");
    if (!active) return null;

    return {
      runId: active._id,
      status: active.status,
      cancelRequested: active.cancelRequested === true
    };
  }
});

export const get = queryGeneric({
  args: {
    sessionToken: v.string(),
    runId: v.id("runs")
  },
  handler: async (ctx, args) => {
    await requireSession(ctx, args.sessionToken);
    return await ctx.db.get(args.runId);
  }
});

export const create = mutationGeneric({
  args: {
    sessionToken: v.string(),
    sourceSlug: v.string(),
    requestedBy: v.optional(v.string())
  },
  handler: async (ctx, args) => {
    await requireSession(ctx, args.sessionToken);
    const runId = await ctx.db.insert("runs", {
      sourceSlug: args.sourceSlug,
      status: "pending",
      requestedBy: args.requestedBy,
      cancelRequested: false
    });

    await ctx.db.insert("runEvents", {
      runId,
      ts: Date.now(),
      level: "info",
      type: "log",
      payload: { message: "Run requested" }
    });

    return { runId };
  }
});

export const requestCancel = mutationGeneric({
  args: {
    sessionToken: v.string(),
    runId: v.id("runs")
  },
  handler: async (ctx, args) => {
    await requireSession(ctx, args.sessionToken);
    const run = await ctx.db.get(args.runId);
    if (!run) {
      throw new Error("Run not found");
    }

    if (run.status === "completed" || run.status === "failed" || run.status === "canceled") {
      return { ok: true, alreadyRequested: true };
    }

    if (run.cancelRequested === true) {
      return { ok: true, alreadyRequested: true };
    }

    await ctx.db.patch(args.runId, { cancelRequested: true });
    await ctx.db.insert("runEvents", {
      runId: args.runId,
      ts: Date.now(),
      level: "warn",
      type: "log",
      payload: { message: "Cancel requested" }
    });

    return { ok: true, alreadyRequested: false };
  }
});

export const setJob = mutationGeneric({
  args: {
    sessionToken: v.string(),
    runId: v.id("runs"),
    job: v.any()
  },
  handler: async (ctx, args) => {
    await requireSession(ctx, args.sessionToken);
    await ctx.db.patch(args.runId, { job: args.job });
    return { ok: true };
  }
});

export const setStatus = mutationGeneric({
  args: {
    sessionToken: v.string(),
    runId: v.id("runs"),
    status: runStatus,
    productsFound: v.optional(v.number()),
    missingItemIds: v.optional(v.number()),
    error: v.optional(v.string())
  },
  handler: async (ctx, args) => {
    await requireSession(ctx, args.sessionToken);
    const now = Date.now();
    const patch: Record<string, unknown> = { status: args.status };
    if (typeof args.productsFound === "number") {
      patch.productsFound = args.productsFound;
    }
    if (typeof args.missingItemIds === "number") {
      patch.missingItemIds = args.missingItemIds;
    }
    if (typeof args.error === "string") {
      patch.error = args.error;
    }
    if (args.status === "running") {
      patch.startedAt = now;
    }
    if (args.status === "completed" || args.status === "failed" || args.status === "canceled") {
      patch.completedAt = now;
    }
    await ctx.db.patch(args.runId, patch);

    if (args.status === "completed") {
      const run = await ctx.db.get(args.runId);
      if (run) {
        if (run.requestedBy === "builder") {
          return { ok: true };
        }
        const source = await ctx.db
          .query("sources")
          .withIndex("by_slug", (q) => q.eq("slug", run.sourceSlug))
          .unique();
        if (source) {
          await ctx.db.patch(source._id, { lastSuccessfulRunId: args.runId, lastSuccessfulAt: now });
        }
      }
    }

    return { ok: true };
  }
});

export const appendEvent = mutationGeneric({
  args: {
    sessionToken: v.string(),
    runId: v.id("runs"),
    level: runLevel,
    type: runEventType,
    payload: v.any()
  },
  handler: async (ctx, args) => {
    await requireSession(ctx, args.sessionToken);
    const id = await ctx.db.insert("runEvents", {
      runId: args.runId,
      ts: Date.now(),
      level: args.level,
      type: args.type,
      payload: args.payload
    });
    return { id };
  }
});

export const listEvents = queryGeneric({
  args: {
    sessionToken: v.string(),
    runId: v.id("runs"),
    limit: v.optional(v.number())
  },
  handler: async (ctx, args) => {
    await requireSession(ctx, args.sessionToken);
    const limit = Math.min(Math.max(args.limit ?? 100, 1), 500);
    return await ctx.db
      .query("runEvents")
      .withIndex("by_runId_ts", (q) => q.eq("runId", args.runId))
      .order("desc")
      .take(limit);
  }
});
