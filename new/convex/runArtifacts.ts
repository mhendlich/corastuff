import { mutationGeneric, queryGeneric } from "convex/server";
import { v } from "convex/values";
import { requireSession } from "./authz";

const artifactType = v.union(
  v.literal("log"),
  v.literal("json"),
  v.literal("html"),
  v.literal("screenshot"),
  v.literal("other")
);

export const listForRun = queryGeneric({
  args: {
    sessionToken: v.string(),
    runId: v.id("runs")
  },
  handler: async (ctx, args) => {
    await requireSession(ctx, args.sessionToken);
    const docs = await ctx.db
      .query("runArtifacts")
      .withIndex("by_runId", (q) => q.eq("runId", args.runId))
      .collect();
    docs.sort((a, b) => a.key.localeCompare(b.key));
    return docs;
  }
});

export const upsertMany = mutationGeneric({
  args: {
    sessionToken: v.string(),
    runId: v.id("runs"),
    artifacts: v.array(
      v.object({
        key: v.string(),
        type: artifactType,
        path: v.string()
      })
    )
  },
  handler: async (ctx, args) => {
    await requireSession(ctx, args.sessionToken);
    const now = Date.now();
    let created = 0;
    let updated = 0;

    for (const artifact of args.artifacts) {
      const key = artifact.key.trim();
      const path = artifact.path.trim();
      if (!key || !path) continue;

      const existing = await ctx.db
        .query("runArtifacts")
        .withIndex("by_runId_key", (q) => q.eq("runId", args.runId).eq("key", key))
        .unique();

      if (existing) {
        await ctx.db.patch(existing._id, { type: artifact.type, path, updatedAt: now });
        updated += 1;
      } else {
        await ctx.db.insert("runArtifacts", {
          runId: args.runId,
          key,
          type: artifact.type,
          path,
          createdAt: now,
          updatedAt: now
        });
        created += 1;
      }
    }

    return { ok: true, created, updated };
  }
});
