import type { RunEventDoc } from "../../convexFns";

export function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

export function eventSummary(e: RunEventDoc) {
  const base = `${new Date(e.ts).toLocaleTimeString()} [${e.level}]`;
  if (isRecord(e.payload) && typeof e.payload.message === "string") return `${base} ${e.payload.message}`;
  return `${base} ${JSON.stringify(e.payload)}`;
}
