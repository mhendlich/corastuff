import { internalMutationGeneric, queryGeneric, mutationGeneric } from "convex/server";
import { v } from "convex/values";

export const validateSession = queryGeneric({
  args: { sessionToken: v.string() },
  handler: async (ctx, args) => {
    const token = args.sessionToken.trim();
    if (!token) return null;

    const session = await ctx.db
      .query("authSessions")
      .withIndex("by_token", (q) => q.eq("token", token))
      .unique();
    if (!session) return null;
    if (typeof session.expiresAt !== "number" || session.expiresAt <= Date.now()) return null;
    if (typeof session.revokedAt === "number") return null;

    return {
      kind: session.kind,
      label: typeof session.label === "string" ? session.label : null,
      expiresAt: session.expiresAt
    };
  }
});

export const logout = mutationGeneric({
  args: { sessionToken: v.string() },
  handler: async (ctx, args) => {
    const token = args.sessionToken.trim();
    if (!token) return { ok: true, deleted: false };

    const session = await ctx.db
      .query("authSessions")
      .withIndex("by_token", (q) => q.eq("token", token))
      .unique();
    if (!session) return { ok: true, deleted: false };

    await ctx.db.delete(session._id);
    return { ok: true, deleted: true };
  }
});

export const internalCreateSession = internalMutationGeneric({
  args: {
    token: v.string(),
    kind: v.union(v.literal("user"), v.literal("service")),
    label: v.optional(v.string()),
    ttlMs: v.optional(v.number())
  },
  handler: async (ctx, args) => {
    const now = Date.now();
    const ttlMsRaw = args.ttlMs ?? 1000 * 60 * 60 * 24 * 30; // 30d
    const ttlMs = Math.min(Math.max(ttlMsRaw, 1000 * 60), 1000 * 60 * 60 * 24 * 90); // 1m..90d
    const expiresAt = now + ttlMs;

    const token = args.token.trim();
    if (!token) throw new Error("token is required");

    await ctx.db.insert("authSessions", {
      token,
      kind: args.kind,
      label: (args.label ?? "").trim() || undefined,
      createdAt: now,
      expiresAt
    });

    return { ok: true, expiresAt };
  }
});

