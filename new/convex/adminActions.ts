"use node";

import { actionGeneric, makeFunctionReference } from "convex/server";
import { v } from "convex/values";
import { requireSessionForAction } from "./authz";

type TableName =
  | "runEvents"
  | "runArtifacts"
  | "pricePoints"
  | "productLinks"
  | "canonicalProducts"
  | "productsLatest"
  | "runs"
  | "schedules";

type ScheduleDoc = {
  sourceSlug: string;
  enabled: boolean;
};

type EnqueuerScheduleResponse = {
  ok?: unknown;
  removed?: unknown;
};

async function removeSchedulerInQueue(payload: { sourceSlug: string }) {
  const baseUrl = process.env.CORASTUFF_ENQUEUER_URL ?? "http://enqueuer:4000";
  const url = new URL("/schedules/upsert", baseUrl).toString();
  const resp = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ sourceSlug: payload.sourceSlug, enabled: false })
  });
  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    throw new Error(
      `Enqueuer schedule API failed: ${resp.status} ${resp.statusText}${text ? ` - ${text}` : ""}`
    );
  }
  const data = (await resp.json()) as EnqueuerScheduleResponse;
  return { removed: data.removed === true };
}

const schedulesList = makeFunctionReference<"query", { sessionToken: string }, ScheduleDoc[]>("schedules:list");

const deleteBatchForTable = makeFunctionReference<
  "mutation",
  { sessionToken: string; table: TableName; limit?: number },
  { deleted: number; done: boolean }
>("admin:deleteBatchForTable");

const backfillProductsLatestLastSeenRunIdBatch = makeFunctionReference<
  "mutation",
  { sessionToken: string; paginationOpts: { numItems: number; cursor: string | null }; dryRun?: boolean },
  {
    ok: boolean;
    scanned: number;
    patched: number;
    alreadySet: number;
    missingSourceRunId: number;
    done: boolean;
    continueCursor: string | null;
  }
>("admin:backfillProductsLatestLastSeenRunIdBatch");

export const resetAll = actionGeneric({
  args: {
    sessionToken: v.string(),
    deleteSchedules: v.optional(v.boolean())
  },
  handler: async (ctx, args) => {
    await requireSessionForAction(ctx, args.sessionToken);
    const deleteSchedules = args.deleteSchedules ?? true;

    const schedules = await ctx.runQuery(schedulesList, { sessionToken: args.sessionToken });
    const scheduleSourceSlugs = Array.from(
      new Set(
        schedules
          .map((s) => (typeof s.sourceSlug === "string" ? s.sourceSlug.trim() : ""))
          .filter((s) => s.length > 0)
      )
    );

    let queueSchedulersRemoved = 0;
    if (deleteSchedules && scheduleSourceSlugs.length > 0) {
      for (const sourceSlug of scheduleSourceSlugs) {
        try {
          const result = await removeSchedulerInQueue({ sourceSlug });
          if (result.removed) queueSchedulersRemoved += 1;
        } catch {
          // best-effort; still reset Convex state even if queue cleanup fails
        }
      }
    }

    const tables: TableName[] = [
      "runEvents",
      "runArtifacts",
      "pricePoints",
      "productLinks",
      "canonicalProducts",
      "productsLatest",
      "runs",
      ...(deleteSchedules ? (["schedules"] as const) : [])
    ];

    const deleted: Record<TableName, number> = {
      runEvents: 0,
      runArtifacts: 0,
      pricePoints: 0,
      productLinks: 0,
      canonicalProducts: 0,
      productsLatest: 0,
      runs: 0,
      schedules: 0
    };

    for (const table of tables) {
      let total = 0;
      // Hard safety cap to avoid burning CPU forever if something goes wrong.
      for (let i = 0; i < 1000; i += 1) {
        const batch = await ctx.runMutation(deleteBatchForTable, { sessionToken: args.sessionToken, table, limit: 1000 });
        total += batch.deleted;
        if (batch.done) break;
      }
      deleted[table] = total;
    }

    return {
      ok: true,
      deleted,
      queueSchedulersRemoved,
      scheduleRowsSeen: scheduleSourceSlugs.length
    };
  }
});

export const backfillProductsLatestLastSeenRunId = actionGeneric({
  args: {
    sessionToken: v.string(),
    dryRun: v.optional(v.boolean()),
    batchSize: v.optional(v.number()),
    maxBatches: v.optional(v.number())
  },
  handler: async (ctx, args) => {
    await requireSessionForAction(ctx, args.sessionToken);
    const dryRun = args.dryRun ?? false;
    const batchSize = Math.min(Math.max(args.batchSize ?? 250, 1), 1000);
    const maxBatches = Math.min(Math.max(args.maxBatches ?? 200, 1), 1000);

    let cursor: string | null = null;
    let batches = 0;
    let scanned = 0;
    let patched = 0;
    let alreadySet = 0;
    let missingSourceRunId = 0;

    for (let i = 0; i < maxBatches; i += 1) {
      const batch = await ctx.runMutation(backfillProductsLatestLastSeenRunIdBatch, {
        sessionToken: args.sessionToken,
        paginationOpts: { numItems: batchSize, cursor },
        dryRun
      });

      batches += 1;
      scanned += batch.scanned;
      patched += batch.patched;
      alreadySet += batch.alreadySet;
      missingSourceRunId += batch.missingSourceRunId;
      cursor = batch.continueCursor;

      if (batch.done) {
        return {
          ok: true,
          dryRun,
          done: true,
          batches,
          scanned,
          patched,
          alreadySet,
          missingSourceRunId
        };
      }
    }

    return {
      ok: true,
      dryRun,
      done: false,
      batches,
      scanned,
      patched,
      alreadySet,
      missingSourceRunId
    };
  }
});
