"use node";

import { randomBytes, timingSafeEqual } from "node:crypto";
import { actionGeneric, makeFunctionReference } from "convex/server";
import { v } from "convex/values";

const internalCreateSession = makeFunctionReference<
  "mutation",
  { token: string; kind: "user" | "service"; label?: string; ttlMs?: number },
  { ok: boolean; expiresAt: number }
>("auth:internalCreateSession");

function safeEqual(a: string, b: string) {
  const aa = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  if (aa.length !== bb.length) return false;
  return timingSafeEqual(aa, bb);
}

export const login = actionGeneric({
  args: {
    password: v.string(),
    kind: v.optional(v.union(v.literal("user"), v.literal("service"))),
    label: v.optional(v.string()),
    ttlMs: v.optional(v.number())
  },
  handler: async (ctx, args) => {
    const expected = process.env.CORASTUFF_PASSWORD ?? "";
    if (!expected) {
      throw new Error("Server is not configured with CORASTUFF_PASSWORD");
    }

    if (!safeEqual(args.password, expected)) {
      throw new Error("Invalid password");
    }

    const kind = args.kind ?? "user";
    const token = randomBytes(32).toString("hex");
    const created = await ctx.runMutation(internalCreateSession, {
      token,
      kind,
      label: (args.label ?? "").trim() || undefined,
      ttlMs: args.ttlMs
    });

    return {
      ok: true,
      sessionToken: token,
      kind,
      label: (args.label ?? "").trim() || null,
      expiresAt: created.expiresAt
    };
  }
});

