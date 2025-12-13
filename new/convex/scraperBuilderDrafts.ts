import { mutationGeneric, queryGeneric } from "convex/server";
import { v } from "convex/values";
import { requireSession } from "./authz";

function ownerKeyForSession(session: { kind: "user" | "service"; label: string | null }): string {
  const label = session.label?.trim() || "default";
  return `${session.kind}:${label}`;
}

function asNonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function inferDraftName(draft: unknown): string | null {
  if (!draft || typeof draft !== "object" || Array.isArray(draft)) return null;
  const obj = draft as Record<string, unknown>;
  const displayName = asNonEmptyString(obj.displayName);
  if (displayName) return displayName;
  const sourceSlug = asNonEmptyString(obj.sourceSlug);
  if (sourceSlug) return sourceSlug;
  const seedUrl = asNonEmptyString(obj.seedUrl);
  if (seedUrl) {
    try {
      const u = new URL(seedUrl);
      return u.hostname;
    } catch {
      return seedUrl;
    }
  }
  return null;
}

async function upsertState(ctx: any, ownerKey: string, currentDraftId: any | null) {
  const now = Date.now();
  const existing = await ctx.db
    .query("scraperBuilderState")
    .withIndex("by_ownerKey", (q: any) => q.eq("ownerKey", ownerKey))
    .unique();

  if (existing) {
    await ctx.db.patch(existing._id, { currentDraftId, updatedAt: now });
    return;
  }

  await ctx.db.insert("scraperBuilderState", { ownerKey, currentDraftId, updatedAt: now });
}

export const listDrafts = queryGeneric({
  args: { sessionToken: v.string() },
  handler: async (ctx, args) => {
    const session = await requireSession(ctx, args.sessionToken);
    const ownerKey = ownerKeyForSession(session);
    return await ctx.db
      .query("scraperBuilderDrafts")
      .withIndex("by_ownerKey_updatedAt", (q) => q.eq("ownerKey", ownerKey))
      .order("desc")
      .take(200);
  }
});

export const getCurrent = queryGeneric({
  args: { sessionToken: v.string() },
  handler: async (ctx, args) => {
    const session = await requireSession(ctx, args.sessionToken);
    const ownerKey = ownerKeyForSession(session);
    const state = await ctx.db
      .query("scraperBuilderState")
      .withIndex("by_ownerKey", (q) => q.eq("ownerKey", ownerKey))
      .unique();

    const currentDraftId = state?.currentDraftId ?? null;
    if (!currentDraftId) return { currentDraftId: null, draft: null };

    const draft = await ctx.db.get(currentDraftId);
    if (!draft || draft.ownerKey !== ownerKey) return { currentDraftId: null, draft: null };
    return { currentDraftId: draft._id, draft };
  }
});

export const getDraft = queryGeneric({
  args: { sessionToken: v.string(), draftId: v.id("scraperBuilderDrafts") },
  handler: async (ctx, args) => {
    const session = await requireSession(ctx, args.sessionToken);
    const ownerKey = ownerKeyForSession(session);
    const draft = await ctx.db.get(args.draftId);
    if (!draft || draft.ownerKey !== ownerKey) return null;
    return draft;
  }
});

export const setCurrent = mutationGeneric({
  args: { sessionToken: v.string(), draftId: v.id("scraperBuilderDrafts") },
  handler: async (ctx, args) => {
    const session = await requireSession(ctx, args.sessionToken);
    const ownerKey = ownerKeyForSession(session);
    const draft = await ctx.db.get(args.draftId);
    if (!draft || draft.ownerKey !== ownerKey) {
      throw new Error("Draft not found");
    }
    await upsertState(ctx, ownerKey, draft._id);
    return { ok: true, currentDraftId: draft._id };
  }
});

export const createDraft = mutationGeneric({
  args: { sessionToken: v.string(), name: v.optional(v.string()), draft: v.any() },
  handler: async (ctx, args) => {
    const session = await requireSession(ctx, args.sessionToken);
    const ownerKey = ownerKeyForSession(session);
    const now = Date.now();

    const name =
      asNonEmptyString(args.name) ?? inferDraftName(args.draft) ?? `Draft ${new Date(now).toISOString().slice(0, 10)}`;

    const id = await ctx.db.insert("scraperBuilderDrafts", {
      ownerKey,
      name,
      draft: args.draft,
      runId: null,
      createdAt: now,
      updatedAt: now
    });

    await upsertState(ctx, ownerKey, id);

    return { ok: true, draftId: id };
  }
});

export const upsertDraft = mutationGeneric({
  args: {
    sessionToken: v.string(),
    draftId: v.id("scraperBuilderDrafts"),
    name: v.optional(v.string()),
    draft: v.any(),
    runId: v.optional(v.union(v.id("runs"), v.null()))
  },
  handler: async (ctx, args) => {
    const session = await requireSession(ctx, args.sessionToken);
    const ownerKey = ownerKeyForSession(session);
    const existing = await ctx.db.get(args.draftId);
    if (!existing || existing.ownerKey !== ownerKey) {
      throw new Error("Draft not found");
    }

    const now = Date.now();
    const patch: Record<string, unknown> = {
      draft: args.draft,
      updatedAt: now
    };

    const name = asNonEmptyString(args.name);
    if (name) patch.name = name;
    if (args.runId !== undefined) patch.runId = args.runId;

    await ctx.db.patch(existing._id, patch);
    return { ok: true };
  }
});

export const deleteDraft = mutationGeneric({
  args: { sessionToken: v.string(), draftId: v.id("scraperBuilderDrafts") },
  handler: async (ctx, args) => {
    const session = await requireSession(ctx, args.sessionToken);
    const ownerKey = ownerKeyForSession(session);
    const existing = await ctx.db.get(args.draftId);
    if (!existing || existing.ownerKey !== ownerKey) {
      return { ok: true, deleted: false };
    }

    await ctx.db.delete(existing._id);

    const state = await ctx.db
      .query("scraperBuilderState")
      .withIndex("by_ownerKey", (q) => q.eq("ownerKey", ownerKey))
      .unique();

    if (state?.currentDraftId === existing._id) {
      const remaining = await ctx.db
        .query("scraperBuilderDrafts")
        .withIndex("by_ownerKey_updatedAt", (q) => q.eq("ownerKey", ownerKey))
        .order("desc")
        .take(10);
      const next = remaining.find((d: any) => d._id !== existing._id) ?? null;
      await upsertState(ctx, ownerKey, next ? next._id : null);
    }

    return { ok: true, deleted: true };
  }
});
