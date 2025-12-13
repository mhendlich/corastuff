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

const sourcesSetEnabled = makeFunctionReference<
  "mutation",
  { sessionToken: string; slug: string; enabled: boolean },
  { ok: boolean }
>("sources:setEnabled");

const sourcesGetBySlug = makeFunctionReference<
  "query",
  { sessionToken: string; slug: string },
  { _id: string; slug: string; enabled: boolean } | null
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
