"use node";

import { actionGeneric, makeFunctionReference } from "convex/server";
import { v } from "convex/values";
import { requireSessionForAction } from "./authz";

type RunScraperJobData = {
  runId: string;
  sourceSlug: string;
};

type EnqueuerCancelResponse = {
  removed?: unknown;
  reason?: unknown;
};

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

async function cancelQueueJob(payload: { queueJobId: string }) {
  const baseUrl = process.env.CORASTUFF_ENQUEUER_URL ?? "http://enqueuer:4000";
  const url = new URL("/cancel", baseUrl).toString();
  const resp = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload)
  });
  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    throw new Error(`Cancel API failed: ${resp.status} ${resp.statusText}${text ? ` - ${text}` : ""}`);
  }
  const data = (await resp.json()) as EnqueuerCancelResponse;
  const removed = data.removed;
  const reason = data.reason;
  return {
    removed: removed === true,
    reason: typeof reason === "string" ? reason : null
  };
}

const runsCreate = makeFunctionReference<
  "mutation",
  { sessionToken: string; sourceSlug: string; requestedBy?: string },
  { runId: string }
>("runs:create");

const runsGetActiveBySource = makeFunctionReference<
  "query",
  { sessionToken: string; sourceSlug: string },
  { runId: string; status: "pending" | "running"; cancelRequested: boolean } | null
>("runs:getActiveBySource");

const runsSetJob = makeFunctionReference<
  "mutation",
  { sessionToken: string; runId: string; job: unknown },
  { ok: boolean }
>("runs:setJob");

const runsGet = makeFunctionReference<
  "query",
  { sessionToken: string; runId: string },
  { status: string; job?: unknown } | null
>("runs:get");

const runsRequestCancel = makeFunctionReference<
  "mutation",
  { sessionToken: string; runId: string },
  { ok: boolean; alreadyRequested: boolean }
>("runs:requestCancel");

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

const sourcesGetBySlug = makeFunctionReference<
  "query",
  { sessionToken: string; slug: string },
  { enabled?: boolean | undefined } | null
>("sources:getBySlug");

const sourcesList = makeFunctionReference<
  "query",
  { sessionToken: string },
  { slug: string; enabled: boolean }[]
>("sources:list");

async function requestOneRun(
  ctx: any,
  args: { sessionToken: string; sourceSlug: string; requestedBy?: string }
) {
  const sourceSlug = args.sourceSlug.trim();
  if (!sourceSlug) throw new Error("sourceSlug is required");

  const source = await ctx.runQuery(sourcesGetBySlug, { sessionToken: args.sessionToken, slug: sourceSlug });
  if (!source) {
    throw new Error(`Unknown sourceSlug: ${sourceSlug}`);
  }
  if (source.enabled !== true) {
    throw new Error(`Source is disabled: ${sourceSlug}`);
  }

  const active = await ctx.runQuery(runsGetActiveBySource, { sessionToken: args.sessionToken, sourceSlug });
  if (active) {
    throw new Error(`Run already ${active.status} for ${sourceSlug} (runId: ${active.runId})`);
  }

  const { runId } = await ctx.runMutation(runsCreate, {
    sessionToken: args.sessionToken,
    sourceSlug,
    requestedBy: args.requestedBy
  });

  let queueJobId: string | null = null;
  try {
    const result = await enqueueRunScraperJob({
      runId,
      sourceSlug
    });
    queueJobId = result.queueJobId;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await ctx.runMutation(runsAppendEvent, {
      sessionToken: args.sessionToken,
      runId,
      level: "error",
      type: "log",
      payload: { message: "Failed to enqueue job", error: message }
    });
    await ctx.runMutation(runsSetStatus, { sessionToken: args.sessionToken, runId, status: "failed", error: message });
    throw err;
  }

  await ctx.runMutation(runsSetJob, {
    sessionToken: args.sessionToken,
    runId,
    job: { queueJobId, enqueuedAt: Date.now() }
  });

  await ctx.runMutation(runsAppendEvent, {
    sessionToken: args.sessionToken,
    runId,
    level: "info",
    type: "log",
    payload: { message: "Enqueued job", queueJobId }
  });

  return { runId, queueJobId };
}

export const request = actionGeneric({
  args: {
    sessionToken: v.string(),
    sourceSlug: v.string(),
    requestedBy: v.optional(v.string())
  },
  handler: async (ctx, args) => {
    await requireSessionForAction(ctx, args.sessionToken);
    return await requestOneRun(ctx, args);
  }
});

export const requestAll = actionGeneric({
  args: {
    sessionToken: v.string(),
    requestedBy: v.optional(v.string()),
    sourceSlugs: v.optional(v.array(v.string()))
  },
  handler: async (ctx, args) => {
    await requireSessionForAction(ctx, args.sessionToken);
    const requestedBy = args.requestedBy;
    const only = args.sourceSlugs?.map((s) => s.trim()).filter(Boolean) ?? null;
    const onlySet = only ? new Set(only) : null;

    const sources = await ctx.runQuery(sourcesList, { sessionToken: args.sessionToken });
    const ordered = sources
      .map((s) => ({ slug: s.slug.trim(), enabled: s.enabled === true }))
      .filter((s) => s.slug.length > 0 && (!onlySet || onlySet.has(s.slug)));

    const results: Array<{
      sourceSlug: string;
      ok: boolean;
      runId?: string;
      queueJobId?: string | null;
      skipped?: "disabled" | "active";
      error?: string;
    }> = [];

    for (const s of ordered) {
      if (!s.enabled) {
        results.push({ sourceSlug: s.slug, ok: false, skipped: "disabled" });
        continue;
      }

      const active = await ctx.runQuery(runsGetActiveBySource, {
        sessionToken: args.sessionToken,
        sourceSlug: s.slug
      });
      if (active) {
        results.push({ sourceSlug: s.slug, ok: false, skipped: "active" });
        continue;
      }

      try {
        const r = await requestOneRun(ctx, { sessionToken: args.sessionToken, sourceSlug: s.slug, requestedBy });
        results.push({ sourceSlug: s.slug, ok: true, runId: r.runId, queueJobId: r.queueJobId });
      } catch (err) {
        results.push({ sourceSlug: s.slug, ok: false, error: err instanceof Error ? err.message : String(err) });
      }
    }

    return { ok: true, results };
  }
});

export const cancel = actionGeneric({
  args: {
    sessionToken: v.string(),
    runId: v.id("runs")
  },
  handler: async (ctx, args) => {
    await requireSessionForAction(ctx, args.sessionToken);
    const runId = args.runId;
    await ctx.runMutation(runsRequestCancel, { sessionToken: args.sessionToken, runId });

    const run = await ctx.runQuery(runsGet, { sessionToken: args.sessionToken, runId });
    if (!run) {
      throw new Error("Run not found");
    }

    const status = run.status;
    if (status === "completed" || status === "failed" || status === "canceled") {
      return { runId, removed: false, reason: "terminal" as const };
    }

    let queueJobId: string | null = null;
    const job = run.job;
    if (job && typeof job === "object" && !Array.isArray(job)) {
      const raw = (job as Record<string, unknown>).queueJobId;
      if (typeof raw === "string" && raw.trim()) queueJobId = raw.trim();
    }

    if (!queueJobId) {
      await ctx.runMutation(runsAppendEvent, {
        sessionToken: args.sessionToken,
        runId,
        level: "warn",
        type: "log",
        payload: { message: "Cancel requested (no queueJobId found)" }
      });
      return { runId, removed: false, reason: "missing_queue_job_id" as const };
    }

    const result = await cancelQueueJob({ queueJobId });
    if (result.removed) {
      await ctx.runMutation(runsSetStatus, { sessionToken: args.sessionToken, runId, status: "canceled" });
      await ctx.runMutation(runsAppendEvent, {
        sessionToken: args.sessionToken,
        runId,
        level: "warn",
        type: "log",
        payload: { message: "Canceled queued job", queueJobId }
      });
      return { runId, removed: true, reason: null as const };
    }

    await ctx.runMutation(runsAppendEvent, {
      sessionToken: args.sessionToken,
      runId,
      level: "warn",
      type: "log",
      payload: { message: "Cancel requested (job may already be running)", queueJobId, reason: result.reason }
    });
    return { runId, removed: false, reason: (result.reason ?? "not_removed") as const };
  }
});
