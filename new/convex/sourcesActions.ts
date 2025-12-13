"use node";

import { actionGeneric, makeFunctionReference } from "convex/server";
import { v } from "convex/values";
import { requireSessionForAction } from "./authz";

type EnqueuerScheduleResponse = {
  ok?: unknown;
  schedulerId?: unknown;
  removed?: unknown;
  nextRunAt?: unknown;
};

type RunScraperJobData = {
  runId: string;
  sourceSlug: string;
  dryRun?: boolean;
  configOverride?: unknown;
};

async function disableScheduleInQueue(payload: { sourceSlug: string }) {
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
  const removed = data.removed;
  return { removed: removed === true };
}

async function enqueueRunScraperJob(data: RunScraperJobData) {
  const baseUrl = process.env.CORASTUFF_ENQUEUER_URL ?? "http://enqueuer:4000";
  const url = new URL("/enqueue", baseUrl).toString();
  const resp = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(data)
  });
  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    throw new Error(`Enqueue API failed: ${resp.status} ${resp.statusText}${text ? ` - ${text}` : ""}`);
  }
  const payload: unknown = await resp.json();
  const queueJobId = (payload as { queueJobId?: unknown }).queueJobId;
  return { queueJobId: queueJobId === null ? null : typeof queueJobId === "string" ? queueJobId : null };
}

const sourcesSetEnabled = makeFunctionReference<
  "mutation",
  { sessionToken: string; slug: string; enabled: boolean },
  { ok: boolean }
>("sources:setEnabled");

const sourcesGetBySlug = makeFunctionReference<
  "query",
  { sessionToken: string; slug: string },
  { _id: string; slug: string; enabled: boolean; config: unknown } | null
>("sources:getBySlug");

const schedulesGetBySourceSlug = makeFunctionReference<
  "query",
  { sessionToken: string; sourceSlug: string },
  { sourceSlug: string; enabled: boolean; intervalMinutes: number } | null
>("schedules:getBySourceSlug");

const schedulesUpsert = makeFunctionReference<
  "mutation",
  { sessionToken: string; sourceSlug: string; enabled: boolean; intervalMinutes: number; nextRunAt?: number },
  { id: string; created: boolean }
>("schedules:upsert");

const runsGetActiveBySource = makeFunctionReference<
  "query",
  { sessionToken: string; sourceSlug: string },
  { runId: string; status: "pending" | "running"; cancelRequested: boolean } | null
>("runs:getActiveBySource");

const runsCreate = makeFunctionReference<
  "mutation",
  { sessionToken: string; sourceSlug: string; requestedBy?: string },
  { runId: string }
>("runs:create");

const runsSetJob = makeFunctionReference<
  "mutation",
  { sessionToken: string; runId: string; job: unknown },
  { ok: boolean }
>("runs:setJob");

const runsAppendEvent = makeFunctionReference<
  "mutation",
  {
    sessionToken: string;
    runId: string;
    level: "debug" | "info" | "warn" | "error";
    type: "log" | "progress" | "metric" | "checkpoint";
    payload: unknown;
  },
  { id: string }
>("runs:appendEvent");

const runsSetStatus = makeFunctionReference<
  "mutation",
  {
    sessionToken: string;
    runId: string;
    status: "pending" | "running" | "completed" | "failed" | "canceled";
    productsFound?: number;
    missingItemIds?: number;
    error?: string;
  },
  { ok: boolean }
>("runs:setStatus");

export const setEnabled = actionGeneric({
  args: {
    sessionToken: v.string(),
    slug: v.string(),
    enabled: v.boolean()
  },
  handler: async (ctx, args) => {
    await requireSessionForAction(ctx, args.sessionToken);
    const slug = args.slug.trim();
    if (!slug) throw new Error("slug is required");

    const source = await ctx.runQuery(sourcesGetBySlug, { sessionToken: args.sessionToken, slug });
    if (!source) throw new Error(`Unknown source slug: ${slug}`);

    if (!args.enabled) {
      await disableScheduleInQueue({ sourceSlug: slug });

      const schedule = await ctx.runQuery(schedulesGetBySourceSlug, { sessionToken: args.sessionToken, sourceSlug: slug });
      if (schedule && schedule.enabled) {
        await ctx.runMutation(schedulesUpsert, {
          sessionToken: args.sessionToken,
          sourceSlug: slug,
          enabled: false,
          intervalMinutes: schedule.intervalMinutes
        });
      }

      await ctx.runMutation(sourcesSetEnabled, { sessionToken: args.sessionToken, slug, enabled: false });
    } else {
      await ctx.runMutation(sourcesSetEnabled, { sessionToken: args.sessionToken, slug, enabled: true });
    }

    return { ok: true, slug, enabled: args.enabled };
  }
});

export const startDryRun = actionGeneric({
  args: {
    sessionToken: v.string(),
    sourceSlug: v.string(),
    configOverride: v.optional(v.any())
  },
  handler: async (ctx, args) => {
    await requireSessionForAction(ctx, args.sessionToken);
    const sourceSlug = args.sourceSlug.trim();
    if (!sourceSlug) throw new Error("sourceSlug is required");

    const source = await ctx.runQuery(sourcesGetBySlug, { sessionToken: args.sessionToken, slug: sourceSlug });
    if (!source) {
      throw new Error(`Unknown source slug: ${sourceSlug}`);
    }

    const active = await ctx.runQuery(runsGetActiveBySource, { sessionToken: args.sessionToken, sourceSlug });
    if (active) {
      throw new Error(`Run already ${active.status} for ${sourceSlug} (runId: ${active.runId})`);
    }

    const config = args.configOverride !== undefined ? args.configOverride : source.config;
    if (config === undefined || config === null) {
      throw new Error("Source config is missing");
    }

    const { runId } = await ctx.runMutation(runsCreate, {
      sessionToken: args.sessionToken,
      sourceSlug,
      requestedBy: "test"
    });

    let queueJobId: string | null = null;
    try {
      const result = await enqueueRunScraperJob({
        runId,
        sourceSlug,
        dryRun: true,
        configOverride: config
      });
      queueJobId = result.queueJobId;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await ctx.runMutation(runsAppendEvent, {
        sessionToken: args.sessionToken,
        runId,
        level: "error",
        type: "log",
        payload: { message: "Failed to enqueue test dry-run", error: message }
      });
      await ctx.runMutation(runsSetStatus, { sessionToken: args.sessionToken, runId, status: "failed", error: message });
      throw err;
    }

    await ctx.runMutation(runsSetJob, {
      sessionToken: args.sessionToken,
      runId,
      job: { queueJobId, enqueuedAt: Date.now(), kind: "test", dryRun: true }
    });

    await ctx.runMutation(runsAppendEvent, {
      sessionToken: args.sessionToken,
      runId,
      level: "info",
      type: "log",
      payload: { message: "Enqueued test dry-run", queueJobId }
    });

    return { ok: true, runId, queueJobId };
  }
});
