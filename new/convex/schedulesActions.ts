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

async function upsertScheduleInQueue(payload: {
  sourceSlug: string;
  enabled: boolean;
  intervalMinutes: number;
}) {
  const baseUrl = process.env.CORASTUFF_ENQUEUER_URL ?? "http://enqueuer:4000";
  const url = new URL("/schedules/upsert", baseUrl).toString();
  const resp = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload)
  });
  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    throw new Error(
      `Enqueuer schedule API failed: ${resp.status} ${resp.statusText}${text ? ` - ${text}` : ""}`
    );
  }
  const data = (await resp.json()) as EnqueuerScheduleResponse;
  const nextRunAt = data.nextRunAt;
  return {
    nextRunAt: typeof nextRunAt === "number" ? nextRunAt : null
  };
}

const schedulesUpsert = makeFunctionReference<
  "mutation",
  { sessionToken: string; sourceSlug: string; enabled: boolean; intervalMinutes: number; nextRunAt?: number },
  { id: string; created: boolean }
>("schedules:upsert");

export const upsert = actionGeneric({
  args: {
    sessionToken: v.string(),
    sourceSlug: v.string(),
    enabled: v.boolean(),
    intervalMinutes: v.number()
  },
  handler: async (ctx, args) => {
    await requireSessionForAction(ctx, args.sessionToken);
    const sourceSlug = args.sourceSlug.trim();
    if (!sourceSlug) {
      throw new Error("sourceSlug is required");
    }
    if (!Number.isFinite(args.intervalMinutes) || args.intervalMinutes <= 0) {
      throw new Error("intervalMinutes must be a positive number");
    }

    const result = await upsertScheduleInQueue({
      sourceSlug,
      enabled: args.enabled,
      intervalMinutes: args.intervalMinutes
    });

    const nextRunAt =
      args.enabled && typeof result.nextRunAt === "number" ? result.nextRunAt : undefined;

    const dbResult = await ctx.runMutation(schedulesUpsert, {
      sessionToken: args.sessionToken,
      sourceSlug,
      enabled: args.enabled,
      intervalMinutes: args.intervalMinutes,
      nextRunAt
    });

    return { ...dbResult, nextRunAt: nextRunAt ?? null };
  }
});
