import { useQuery } from "convex/react";
import { insightsSnapshot, type InsightsMover, type InsightsSnapshot } from "../convexFns";
import { fmtAgo, fmtTs } from "../lib/time";

function fmtMoney(price: number, currency: string | null) {
  const p = Number.isFinite(price) ? price.toFixed(2) : "—";
  return currency ? `${p} ${currency}` : p;
}

function fmtDelta(m: InsightsMover) {
  if (typeof m.changeAbs !== "number" && typeof m.changePct !== "number") return "—";
  const abs = typeof m.changeAbs === "number" ? `${m.changeAbs >= 0 ? "+" : ""}${m.changeAbs.toFixed(2)}` : null;
  const pct = typeof m.changePct === "number" ? `${m.changePct >= 0 ? "+" : ""}${m.changePct.toFixed(1)}%` : null;
  if (abs && pct) return `${abs} (${pct})`;
  return abs ?? pct ?? "—";
}

function MoverRow(props: { kind: "drop" | "spike"; m: InsightsMover }) {
  const { kind, m } = props;
  const accent =
    kind === "drop"
      ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-100"
      : "border-amber-500/30 bg-amber-500/10 text-amber-100";
  return (
    <div className="flex items-start justify-between gap-3 rounded-lg border border-slate-800 bg-slate-900/40 p-3">
      <div className="min-w-0">
        <div className="truncate text-sm font-medium text-slate-100" title={m.name}>
          {m.name}
        </div>
        <div className="mt-1 flex flex-wrap items-center gap-2 text-[11px] text-slate-400">
          <span className={`inline-flex items-center rounded-full border px-2 py-0.5 ${accent}`}>
            {m.sourceDisplayName}
          </span>
          <span className="tabular-nums">{fmtMoney(m.price, m.currency)}</span>
          {m.prevPrice !== null ? (
            <span className="tabular-nums text-slate-500">prev {fmtMoney(m.prevPrice, m.currency)}</span>
          ) : null}
        </div>
      </div>
      <div className="shrink-0 text-right">
        <div className={`text-sm font-semibold tabular-nums ${kind === "drop" ? "text-emerald-200" : "text-amber-200"}`}>
          {fmtDelta(m)}
        </div>
        <div className="mt-1 text-[11px] text-slate-500">{fmtAgo(m.lastSeenAt)}</div>
      </div>
    </div>
  );
}

function Tile(props: { label: string; value: string; hint: string; tone?: "brand" | "warn" | "danger" | "neutral" }) {
  const tone = props.tone ?? "neutral";
  const cls =
    tone === "brand"
      ? "border-slate-800 bg-gradient-to-br from-brand/25 via-slate-900/40 to-brand-cyan/10"
      : tone === "warn"
        ? "border-slate-800 bg-gradient-to-br from-amber-500/15 via-slate-900/40 to-rose-500/10"
        : tone === "danger"
          ? "border-slate-800 bg-gradient-to-br from-rose-500/20 via-slate-900/40 to-slate-950/30"
          : "border-slate-800 bg-slate-900/40";
  return (
    <div className={`rounded-lg border p-4 ${cls}`}>
      <div className="text-[11px] uppercase tracking-[0.18em] text-slate-400">{props.label}</div>
      <div className="mt-2 text-3xl font-semibold tabular-nums text-slate-100">{props.value}</div>
      <div className="mt-1 text-xs text-slate-400">{props.hint}</div>
    </div>
  );
}

export function InsightsPage(props: { sessionToken: string }) {
  const snapshot: InsightsSnapshot | undefined = useQuery(insightsSnapshot, { sessionToken: props.sessionToken });

  if (snapshot === undefined) {
    return (
      <div className="mx-auto max-w-6xl px-6 py-10">
        <div className="text-sm text-slate-300">Loading insights…</div>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-6xl px-6 py-10 space-y-6">
      <div className="flex items-center justify-between">
        <div className="text-xs text-slate-500">Generated {fmtTs(snapshot.generatedAt)}</div>
      </div>

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-6">
        <Tile
          label="Recent Drops"
          value={String(snapshot.summary.recentDrops)}
          hint="Big reductions vs previous scrape."
          tone="brand"
        />
        <Tile
          label="Recent Spikes"
          value={String(snapshot.summary.recentSpikes)}
          hint="Large upticks needing validation."
          tone="warn"
        />
        <Tile label="New Extremes" value="—" hint="Coming soon." />
        <Tile label="Outliers" value="—" hint="Coming soon." />
        <Tile label="Stale Sources" value={String(snapshot.summary.staleSources)} hint="Older than 12h since last success." />
        <Tile
          label="Recent Failures"
          value={String(snapshot.summary.recentFailures)}
          hint="Failed runs in last 36h."
          tone="danger"
        />
      </div>

      <section className="grid gap-4 lg:grid-cols-3">
        <div className="rounded-lg border border-slate-800 bg-slate-900/40 lg:col-span-2">
          <div className="flex items-center justify-between border-b border-slate-800 px-5 py-4">
            <div>
              <h2 className="text-sm font-semibold text-slate-100">Last-Run Movers</h2>
              <p className="mt-0.5 text-xs text-slate-400">Biggest swings since the previous scrape</p>
            </div>
          </div>
          <div className="grid gap-0 divide-y divide-slate-800 md:grid-cols-2 md:divide-x md:divide-y-0">
            <div className="p-5 space-y-3">
              <div className="text-xs uppercase tracking-[0.18em] text-emerald-200/90">
                Drops <span className="ml-2 text-slate-500">{snapshot.movers.drops.length}</span>
              </div>
              {snapshot.movers.drops.length > 0 ? (
                <div className="space-y-2">
                  {snapshot.movers.drops.map((m) => (
                    <MoverRow key={`${m.sourceSlug}:${m.itemId}`} kind="drop" m={m} />
                  ))}
                </div>
              ) : (
                <div className="text-sm text-slate-400">No drops detected yet.</div>
              )}
            </div>
            <div className="p-5 space-y-3">
              <div className="text-xs uppercase tracking-[0.18em] text-amber-200/90">
                Spikes <span className="ml-2 text-slate-500">{snapshot.movers.spikes.length}</span>
              </div>
              {snapshot.movers.spikes.length > 0 ? (
                <div className="space-y-2">
                  {snapshot.movers.spikes.map((m) => (
                    <MoverRow key={`${m.sourceSlug}:${m.itemId}`} kind="spike" m={m} />
                  ))}
                </div>
              ) : (
                <div className="text-sm text-slate-400">No spikes detected yet.</div>
              )}
            </div>
          </div>
          <div className="border-t border-slate-800 px-5 py-4 text-xs text-slate-500">
            Note: mover signals appear after an item has at least 2 price points (two scrapes).
          </div>
        </div>

        <div className="space-y-4">
          <div className="rounded-lg border border-slate-800 bg-slate-900/40">
            <div className="flex items-center justify-between border-b border-slate-800 px-5 py-4">
              <h3 className="text-sm font-semibold text-slate-100">Stale Sources</h3>
              <span className="text-xs text-slate-500 tabular-nums">{snapshot.staleSources.length}</span>
            </div>
            <div className="p-5 space-y-2">
              {snapshot.staleSources.length > 0 ? (
                snapshot.staleSources.slice(0, 10).map((s) => (
                  <div key={s.sourceSlug} className="flex items-center justify-between gap-3 text-sm">
                    <div className="min-w-0 truncate text-slate-200">{s.displayName}</div>
                    <div className="shrink-0 text-xs text-slate-500">
                      {s.lastSuccessfulAt ? fmtAgo(s.lastSuccessfulAt) : "never"}
                    </div>
                  </div>
                ))
              ) : (
                <div className="text-sm text-slate-400">All sources look fresh.</div>
              )}
            </div>
          </div>

          <div className="rounded-lg border border-slate-800 bg-slate-900/40">
            <div className="flex items-center justify-between border-b border-slate-800 px-5 py-4">
              <h3 className="text-sm font-semibold text-slate-100">Recent Failures</h3>
              <span className="text-xs text-slate-500 tabular-nums">{snapshot.recentFailures.length}</span>
            </div>
            <div className="p-5 space-y-3">
              {snapshot.recentFailures.length > 0 ? (
                snapshot.recentFailures.map((f) => (
                  <div key={f.runId} className="rounded-lg border border-rose-500/20 bg-rose-500/10 p-3">
                    <div className="flex items-center justify-between gap-3">
                      <div className="min-w-0 truncate text-sm font-medium text-slate-100">{f.sourceSlug}</div>
                      <div className="shrink-0 text-[11px] text-slate-300">{fmtTs(f.startedAt)}</div>
                    </div>
                    {f.error ? (
                      <div className="mt-1 max-h-16 overflow-hidden text-xs text-slate-200/90">{f.error}</div>
                    ) : (
                      <div className="mt-1 text-xs text-slate-300">No error message.</div>
                    )}
                  </div>
                ))
              ) : (
                <div className="text-sm text-slate-400">No recent failures.</div>
              )}
            </div>
          </div>
        </div>
      </section>
    </div>
  );
}
