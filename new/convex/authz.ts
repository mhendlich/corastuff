import { makeFunctionReference } from "convex/server";

export type SessionInfo = {
  kind: "user" | "service";
  label: string | null;
  expiresAt: number;
};

export async function requireSession(ctx: { db: any }, sessionToken: string): Promise<SessionInfo> {
  const token = sessionToken.trim();
  if (!token) {
    throw new Error("Unauthorized");
  }

  const session = await ctx.db
    .query("authSessions")
    .withIndex("by_token", (q: any) => q.eq("token", token))
    .unique();

  if (!session) throw new Error("Unauthorized");
  if (typeof session.expiresAt !== "number" || session.expiresAt <= Date.now()) throw new Error("Unauthorized");
  if (typeof session.revokedAt === "number") throw new Error("Unauthorized");

  return {
    kind: session.kind,
    label: typeof session.label === "string" ? session.label : null,
    expiresAt: session.expiresAt
  };
}

const authValidateSession = makeFunctionReference<
  "query",
  { sessionToken: string },
  SessionInfo | null
>("auth:validateSession");

export async function requireSessionForAction(ctx: any, sessionToken: string): Promise<SessionInfo> {
  const token = sessionToken.trim();
  if (!token) {
    throw new Error("Unauthorized");
  }

  const session = await ctx.runQuery(authValidateSession, { sessionToken: token });
  if (!session) throw new Error("Unauthorized");
  return session;
}

