"use node";

import { actionGeneric } from "convex/server";
import { v } from "convex/values";
import { requireSessionForAction } from "./authz";

type EnqueuerAutomationStatusResponse = {
  paused?: unknown;
};

async function enqueuerFetchJson(url: string, init?: RequestInit) {
  const resp = await fetch(url, init);
  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    throw new Error(
      `Enqueuer automation API failed: ${resp.status} ${resp.statusText}${text ? ` - ${text}` : ""}`
    );
  }
  return (await resp.json()) as unknown;
}

function parsePaused(payload: unknown) {
  const paused = (payload as EnqueuerAutomationStatusResponse | null)?.paused;
  return paused === true;
}

export const status = actionGeneric({
  args: { sessionToken: v.string() },
  handler: async (ctx, args) => {
    await requireSessionForAction(ctx, args.sessionToken);
    const baseUrl = process.env.CORASTUFF_ENQUEUER_URL ?? "http://enqueuer:4000";
    const url = new URL("/schedules/status", baseUrl).toString();
    const payload = await enqueuerFetchJson(url, { method: "GET" });
    return { paused: parsePaused(payload) };
  }
});

export const pause = actionGeneric({
  args: { sessionToken: v.string() },
  handler: async (ctx, args) => {
    await requireSessionForAction(ctx, args.sessionToken);
    const baseUrl = process.env.CORASTUFF_ENQUEUER_URL ?? "http://enqueuer:4000";
    const url = new URL("/schedules/pause", baseUrl).toString();
    const payload = await enqueuerFetchJson(url, { method: "POST" });
    return { paused: parsePaused(payload) };
  }
});

export const resume = actionGeneric({
  args: { sessionToken: v.string() },
  handler: async (ctx, args) => {
    await requireSessionForAction(ctx, args.sessionToken);
    const baseUrl = process.env.CORASTUFF_ENQUEUER_URL ?? "http://enqueuer:4000";
    const url = new URL("/schedules/resume", baseUrl).toString();
    const payload = await enqueuerFetchJson(url, { method: "POST" });
    return { paused: parsePaused(payload) };
  }
});

