import type { RunStatus } from "@corastuff/shared";

export function StatusPill({ status }: { status: RunStatus }) {
  const cls =
    status === "completed"
      ? "bg-emerald-900/40 text-emerald-200 border-emerald-800"
      : status === "failed"
        ? "bg-rose-900/40 text-rose-200 border-rose-800"
        : status === "running"
          ? "bg-sky-900/40 text-sky-200 border-sky-800"
          : status === "canceled"
            ? "bg-slate-800/60 text-slate-200 border-slate-700"
            : "bg-amber-900/40 text-amber-200 border-amber-800";

  return (
    <span className={`inline-flex items-center rounded-full border px-2 py-0.5 text-xs ${cls}`}>
      {status}
    </span>
  );
}

