import { mutationGeneric, paginationOptsValidator } from "convex/server";
import { v } from "convex/values";
import { requireSession } from "./authz";

const tableName = v.union(
  v.literal("runEvents"),
  v.literal("runArtifacts"),
  v.literal("pricePoints"),
  v.literal("productLinks"),
  v.literal("canonicalProducts"),
  v.literal("productsLatest"),
  v.literal("runs"),
  v.literal("schedules")
);

type TableName =
  | "runEvents"
  | "runArtifacts"
  | "pricePoints"
  | "productLinks"
  | "canonicalProducts"
  | "productsLatest"
  | "runs"
  | "schedules";

async function deleteBatch(ctx: { db: any }, table: TableName, limit: number) {
  const docs = await ctx.db.query(table).take(limit);
  for (const doc of docs) {
    await ctx.db.delete(doc._id);
  }
  return { deleted: docs.length, done: docs.length < limit };
}

export const deleteBatchForTable = mutationGeneric({
  args: {
    sessionToken: v.string(),
    table: tableName,
    limit: v.optional(v.number())
  },
  handler: async (ctx, args) => {
    await requireSession(ctx, args.sessionToken);
    const limit = Math.min(Math.max(args.limit ?? 500, 1), 2000);
    return await deleteBatch(ctx, args.table, limit);
  }
});

export const backfillProductsLatestLastSeenRunIdBatch = mutationGeneric({
  args: {
    sessionToken: v.string(),
    paginationOpts: paginationOptsValidator,
    dryRun: v.optional(v.boolean())
  },
  handler: async (ctx, args) => {
    await requireSession(ctx, args.sessionToken);
    const dryRun = args.dryRun ?? false;

    const sources = await ctx.db.query("sources").withIndex("by_slug").collect();
    const lastSuccessfulRunIdBySlug = new Map<string, string>();
    for (const s of sources) {
      if (s.lastSuccessfulRunId) {
        lastSuccessfulRunIdBySlug.set(s.slug, s.lastSuccessfulRunId);
      }
    }

    const page = await ctx.db.query("productsLatest").order("asc").paginate(args.paginationOpts);

    let scanned = 0;
    let patched = 0;
    let alreadySet = 0;
    let missingSourceRunId = 0;

    for (const doc of page.page) {
      scanned += 1;
      if (doc.lastSeenRunId) {
        alreadySet += 1;
        continue;
      }

      const runId = lastSuccessfulRunIdBySlug.get(doc.sourceSlug);
      if (!runId) {
        missingSourceRunId += 1;
        continue;
      }

      if (!dryRun) {
        await ctx.db.patch(doc._id, { lastSeenRunId: runId });
      }
      patched += 1;
    }

    return {
      ok: true,
      scanned,
      patched,
      alreadySet,
      missingSourceRunId,
      done: page.isDone,
      continueCursor: page.continueCursor
    };
  }
});
