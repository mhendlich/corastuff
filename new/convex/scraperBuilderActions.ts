"use node";

import { actionGeneric, makeFunctionReference } from "convex/server";
import { v } from "convex/values";
import { requireSessionForAction } from "./authz";

type RunScraperJobData = {
  runId: string;
  sourceSlug: string;
  dryRun?: boolean;
  configOverride?: unknown;
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

const builderUpsertCurrent = makeFunctionReference<
  "mutation",
  { sessionToken: string; draft: unknown; runId?: string },
  { ok: boolean; created: boolean }
>("scraperBuilder:upsertCurrent");

export const startDryRun = actionGeneric({
  args: {
    sessionToken: v.string(),
    draft: v.any()
  },
  handler: async (ctx, args) => {
    await requireSessionForAction(ctx, args.sessionToken);

    const draft =
      args.draft && typeof args.draft === "object" && !Array.isArray(args.draft) ? (args.draft as Record<string, unknown>) : null;
    const sourceSlugRaw = draft ? draft.sourceSlug : null;
    const config = draft ? draft.config : null;

    const sourceSlug = typeof sourceSlugRaw === "string" ? sourceSlugRaw.trim() : "";
    if (!sourceSlug) {
      throw new Error("draft.sourceSlug is required");
    }
    if (!config) {
      throw new Error("draft.config is required");
    }

    await ctx.runMutation(builderUpsertCurrent, { sessionToken: args.sessionToken, draft: args.draft });

    const { runId } = await ctx.runMutation(runsCreate, {
      sessionToken: args.sessionToken,
      sourceSlug,
      requestedBy: "builder"
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
        payload: { message: "Failed to enqueue builder dry-run", error: message }
      });
      await ctx.runMutation(runsSetStatus, { sessionToken: args.sessionToken, runId, status: "failed", error: message });
      throw err;
    }

    await ctx.runMutation(runsSetJob, {
      sessionToken: args.sessionToken,
      runId,
      job: { queueJobId, enqueuedAt: Date.now(), kind: "builder", dryRun: true }
    });

    await ctx.runMutation(runsAppendEvent, {
      sessionToken: args.sessionToken,
      runId,
      level: "info",
      type: "log",
      payload: { message: "Enqueued builder dry-run", queueJobId }
    });

    await ctx.runMutation(builderUpsertCurrent, { sessionToken: args.sessionToken, draft: args.draft, runId });

    return { ok: true, runId, queueJobId };
  }
});

