import { useAction, useMutation, useQuery } from "convex/react";
import { useEffect, useState } from "react";
import { StatusPill } from "../components/StatusPill";
import { fmtAgo, fmtTs } from "../lib/time";
import {
  adminBackfillProductsLatestLastSeenRunId,
  adminResetAll,
  dashboardLastScrapes,
  dashboardStats,
  linksCountsBySource,
  runArtifactsListForRun,
  runsCancel,
  runsListActive,
  runsListEvents,
  runsListRecent,
  runsRequest,
  runsRequestAll,
  schedulesList,
  schedulesUpsert,
  sourcesList,
  sourcesSeedDemo,
  sourcesSetEnabled,
  type BackfillProductsLatestLastSeenRunIdResult,
  type DashboardStats,
  type LinkCountsBySource,
  type ResetAllResult,
  type RunArtifactDoc,
  type RunEventDoc,
  type RunsRequestAllResult,
  type ScheduleDoc,
  type SourceLastScrape
} from "../convexFns";

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function eventSummary(e: RunEventDoc) {
  const base = `${new Date(e.ts).toLocaleTimeString()} [${e.level}]`;
  if (isRecord(e.payload) && typeof e.payload.message === "string") {
    return `${base} ${e.payload.message}`;
  }
  return `${base} ${JSON.stringify(e.payload)}`;
}

function ScheduleEditor(props: {
  sourceSlug: string;
  schedule: ScheduleDoc | null;
  sourceEnabled: boolean;
  onSave: (args: { sourceSlug: string; enabled: boolean; intervalMinutes: number }) => Promise<unknown>;
}) {
  const initialEnabled = props.schedule?.enabled ?? false;
  const initialInterval = props.schedule?.intervalMinutes ?? 60;
  const [enabled, setEnabled] = useState(initialEnabled);
  const [intervalMinutes, setIntervalMinutes] = useState(initialInterval);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setEnabled(initialEnabled);
    setIntervalMinutes(initialInterval);
  }, [initialEnabled, initialInterval, props.sourceSlug]);

  const dirty = enabled !== initialEnabled || intervalMinutes !== initialInterval;
  const intervalOk = Number.isFinite(intervalMinutes) && intervalMinutes > 0;

  const nextLabel =
    props.schedule?.enabled && typeof props.schedule?.nextRunAt === "number"
      ? `next ${fmtTs(props.schedule.nextRunAt)}`
      : null;

  return (
    <div className="flex flex-col items-end gap-1">
      <div className="flex items-center gap-2">
        <label className="flex items-center gap-1 text-xs text-slate-300">
          <input
            className="h-3 w-3 accent-slate-200"
            type="checkbox"
            checked={enabled}
            disabled={!props.sourceEnabled}
            onChange={(e) => setEnabled(e.target.checked)}
          />
          <span>schedule</span>
        </label>
        <input
          className="w-20 rounded-md border border-slate-700 bg-slate-900 px-2 py-1 text-xs text-slate-100"
          type="number"
          min={1}
          step={1}
          value={intervalMinutes}
          onChange={(e) => setIntervalMinutes(Number(e.target.value))}
          disabled={!enabled || !props.sourceEnabled}
        />
        <span className="text-xs text-slate-400">min</span>
        <button
          className="rounded-md border border-slate-700 bg-slate-900 px-2 py-1 text-xs text-slate-100 hover:bg-slate-800 disabled:opacity-50"
          type="button"
          disabled={!props.sourceEnabled || !dirty || saving || !intervalOk}
          onClick={async () => {
            setSaving(true);
            setError(null);
            try {
              await props.onSave({ sourceSlug: props.sourceSlug, enabled, intervalMinutes });
            } catch (err) {
              setError(err instanceof Error ? err.message : String(err));
            } finally {
              setSaving(false);
            }
          }}
        >
          Save
        </button>
      </div>
      {nextLabel ? <div className="text-[11px] text-slate-500">{nextLabel}</div> : null}
      {!props.sourceEnabled ? (
        <div className="text-[11px] text-slate-500">enable source to schedule runs</div>
      ) : null}
      {error ? <div className="text-[11px] text-rose-200/90">schedule error: {error}</div> : null}
    </div>
  );
}

function SourceEnabledToggle(props: {
  slug: string;
  enabled: boolean;
  onSetEnabled: (args: { slug: string; enabled: boolean }) => Promise<unknown>;
}) {
  const [enabled, setEnabled] = useState(props.enabled);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setEnabled(props.enabled);
  }, [props.enabled, props.slug]);

  return (
    <div className="flex flex-col items-end gap-1">
      <label className="flex items-center gap-1 text-xs text-slate-300">
        <input
          className="h-3 w-3 accent-slate-200"
          type="checkbox"
          checked={enabled}
          disabled={saving}
          onChange={async (e) => {
            const next = e.target.checked;
            setEnabled(next);
            setSaving(true);
            setError(null);
            try {
              await props.onSetEnabled({ slug: props.slug, enabled: next });
            } catch (err) {
              setEnabled(props.enabled);
              setError(err instanceof Error ? err.message : String(err));
            } finally {
              setSaving(false);
            }
          }}
        />
        <span>enabled</span>
      </label>
      {error ? <div className="text-[11px] text-rose-200/90">enable error: {error}</div> : null}
    </div>
  );
}

export function DashboardPage(props: { sessionToken: string }) {
  const { sessionToken } = props;

  const sources = useQuery(sourcesList, { sessionToken }) ?? [];
  const stats: DashboardStats | null = useQuery(dashboardStats, { sessionToken }) ?? null;
  const lastScrapes: SourceLastScrape[] = useQuery(dashboardLastScrapes, { sessionToken }) ?? [];
  const activeRuns = useQuery(runsListActive, { sessionToken }) ?? [];
  const runs = useQuery(runsListRecent, { sessionToken, limit: 20 }) ?? [];
  const schedules = useQuery(schedulesList, { sessionToken }) ?? [];
  const linkCounts =
    useQuery(
      linksCountsBySource,
      sources.length > 0 ? { sessionToken, sourceSlugs: sources.map((s) => s.slug) } : ("skip" as const)
    ) ??
    [];

  const seedDemo = useMutation(sourcesSeedDemo);
  const setSourceEnabled = useAction(sourcesSetEnabled);
  const requestRun = useAction(runsRequest);
  const cancelRun = useAction(runsCancel);
  const upsertSchedule = useAction(schedulesUpsert);
  const resetAll = useAction(adminResetAll);
  const backfillProductsLatestLastSeenRunId = useAction(adminBackfillProductsLatestLastSeenRunId);
  const requestAllRuns = useAction(runsRequestAll);

  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  useEffect(() => {
    if (!selectedRunId && runs.length > 0) {
      setSelectedRunId(runs[0]!._id);
    }
  }, [selectedRunId, runs]);

  const skip = "skip" as const;

  const [canceling, setCanceling] = useState(false);
  const [cancelError, setCancelError] = useState<string | null>(null);

  const [resetting, setResetting] = useState(false);
  const [resetResult, setResetResult] = useState<ResetAllResult | null>(null);
  const [resetError, setResetError] = useState<string | null>(null);

  const runEvents =
    useQuery(runsListEvents, selectedRunId ? { sessionToken, runId: selectedRunId, limit: 80 } : skip) ??
    [];
  const runArtifacts =
    useQuery(runArtifactsListForRun, selectedRunId ? { sessionToken, runId: selectedRunId } : skip) ??
    [];
  const selectedRun = selectedRunId ? runs.find((r) => r._id === selectedRunId) ?? null : null;
  const runEventsChrono = [...runEvents].reverse();
  const runArtifactsByKey = new Map<string, RunArtifactDoc>(runArtifacts.map((a) => [a.key, a]));
  const runLogArtifact = runArtifactsByKey.get("run.log");
  const productsJsonArtifact = runArtifactsByKey.get("products.json");

  const schedulesBySourceSlug = new Map(schedules.map((s) => [s.sourceSlug, s]));
  const countsBySourceSlug = new Map<string, LinkCountsBySource>(linkCounts.map((c) => [c.sourceSlug, c]));
  const lastScrapeBySourceSlug = new Map<string, SourceLastScrape>(lastScrapes.map((s) => [s.sourceSlug, s]));

  const activeRunBySourceSlug = (() => {
    const map = new Map<string, (typeof activeRuns)[number]>();
    for (const r of activeRuns) {
      if (!map.has(r.sourceSlug)) map.set(r.sourceSlug, r);
    }
    return map;
  })();

  const [runRequestingBySlug, setRunRequestingBySlug] = useState<Record<string, boolean>>({});
  const [runRequestErrorBySlug, setRunRequestErrorBySlug] = useState<Record<string, string | null>>({});

  const [runAlling, setRunAlling] = useState(false);
  const [runAllError, setRunAllError] = useState<string | null>(null);
  const [runAllResult, setRunAllResult] = useState<RunsRequestAllResult | null>(null);

  const [backfilling, setBackfilling] = useState(false);
  const [backfillError, setBackfillError] = useState<string | null>(null);
  const [backfillResult, setBackfillResult] = useState<BackfillProductsLatestLastSeenRunIdResult | null>(
    null
  );

  return (
    <div className="mx-auto max-w-6xl px-6 py-10">
      <div className="grid grid-cols-2 gap-3 md:grid-cols-5">
        <div className="rounded-lg border border-slate-800 bg-slate-900/40 p-4">
          <div className="text-xs text-slate-400">Sources</div>
          <div className="mt-1 text-2xl font-semibold tabular-nums">{stats ? stats.sources : "—"}</div>
        </div>
        <div className="rounded-lg border border-slate-800 bg-slate-900/40 p-4">
          <div className="text-xs text-slate-400">Canonicals</div>
          <div className="mt-1 text-2xl font-semibold tabular-nums">{stats ? stats.canonicalProducts : "—"}</div>
        </div>
        <div className="rounded-lg border border-slate-800 bg-slate-900/40 p-4">
          <div className="text-xs text-slate-400">Linked</div>
          <div className="mt-1 text-2xl font-semibold tabular-nums">{stats ? stats.linkedProducts : "—"}</div>
        </div>
        <div className="rounded-lg border border-slate-800 bg-slate-900/40 p-4">
          <div className="text-xs text-slate-400">Unlinked</div>
          <div className="mt-1 text-2xl font-semibold tabular-nums">{stats ? stats.unlinkedProducts : "—"}</div>
        </div>
        <div className="rounded-lg border border-slate-800 bg-slate-900/40 p-4">
          <div className="text-xs text-slate-400">Source products</div>
          <div className="mt-1 text-2xl font-semibold tabular-nums">{stats ? stats.totalProducts : "—"}</div>
        </div>
      </div>

      <div className="mt-6 grid grid-cols-1 gap-6 md:grid-cols-2">
        <div className="rounded-lg border border-slate-800 bg-slate-900/40">
          <div className="flex items-center justify-between border-b border-slate-800 px-4 py-3">
            <div className="text-sm font-medium">Sources</div>
            <div className="flex items-center gap-2">
              <button
                className="rounded-md border border-slate-700 bg-slate-900 px-3 py-1.5 text-xs text-slate-100 hover:bg-slate-800 disabled:opacity-50"
                onClick={async () => {
                  setRunAlling(true);
                  setRunAllError(null);
                  setRunAllResult(null);
                  try {
                    const result = await requestAllRuns({ sessionToken });
                    setRunAllResult(result);
                    const firstOk = result.results.find((r) => r.ok && typeof r.runId === "string");
                    if (firstOk?.runId) setSelectedRunId(firstOk.runId);
                  } catch (err) {
                    setRunAllError(err instanceof Error ? err.message : String(err));
                  } finally {
                    setRunAlling(false);
                  }
                }}
                disabled={runAlling || sources.every((s) => s.enabled !== true)}
                type="button"
              >
                {runAlling ? "Running…" : "Run all enabled"}
              </button>
              <button
                className="rounded-md border border-slate-700 bg-slate-900 px-3 py-1.5 text-xs text-slate-100 hover:bg-slate-800"
                onClick={() => seedDemo({ sessionToken })}
                type="button"
              >
                Seed demo
              </button>
            </div>
          </div>
          <div className="px-4 py-3">
            {runAllError ? <div className="mb-3 text-xs text-rose-200/90">run-all error: {runAllError}</div> : null}
            {runAllResult ? (
              <div className="mb-3 rounded-md border border-slate-800 bg-slate-950/40 px-3 py-2 text-xs text-slate-300">
                {(() => {
                  const ok = runAllResult.results.filter((r) => r.ok).length;
                  const disabled = runAllResult.results.filter((r) => r.skipped === "disabled").length;
                  const active = runAllResult.results.filter((r) => r.skipped === "active").length;
                  const errors = runAllResult.results.filter((r) => !r.ok && !r.skipped).length;
                  return `run-all: ${ok} enqueued · ${active} active · ${disabled} disabled · ${errors} errors`;
                })()}
              </div>
            ) : null}
            {sources.length === 0 ? (
              <div className="text-sm text-slate-300">No sources yet.</div>
            ) : (
              <ul className="space-y-2">
                {sources.map((s) => (
                  <li key={s._id} className="rounded-md border border-slate-800 bg-slate-950/40 px-3 py-2">
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <div className="text-sm">{s.displayName}</div>
                        <div className="mt-0.5 text-xs text-slate-400">{s.slug}</div>
                        <div className="mt-0.5 text-xs text-slate-500">
                          {(() => {
                            const last = lastScrapeBySourceSlug.get(s.slug);
                            if (!last) return <span>last scrape: —</span>;
                            return (
                              <>
                                <span>
                                  last scrape: {last.lastRunAt ? fmtTs(last.lastRunAt) : "—"} ({fmtAgo(last.lastRunAt)})
                                </span>
                                {last.lastRunStatus ? (
                                  <span className="inline-flex items-center gap-1">
                                    <span className="text-slate-600">·</span>
                                    <StatusPill status={last.lastRunStatus} />
                                  </span>
                                ) : null}
                              </>
                            );
                          })()}
                        </div>
                        <div className="mt-0.5 text-xs text-slate-500">
                          {(() => {
                            const c = countsBySourceSlug.get(s.slug);
                            if (!c) return "linking: —";
                            const base = `${c.unlinked} unlinked · ${c.linked} linked · ${c.totalProducts} total`;
                            return c.truncated ? `${base} (truncated)` : base;
                          })()}
                        </div>
                      </div>
                      <div className="flex shrink-0 flex-col items-end gap-2">
                        <SourceEnabledToggle
                          slug={s.slug}
                          enabled={s.enabled}
                          onSetEnabled={(args) => setSourceEnabled({ sessionToken, ...args })}
                        />
                        <button
                          className="rounded-md border border-slate-700 bg-slate-900 px-3 py-1.5 text-xs text-slate-100 hover:bg-slate-800 disabled:opacity-50"
                          onClick={async () => {
                            const active = activeRunBySourceSlug.get(s.slug);
                            if (active) {
                              setSelectedRunId(active._id);
                              return;
                            }

                            setRunRequestingBySlug((prev) => ({ ...prev, [s.slug]: true }));
                            setRunRequestErrorBySlug((prev) => ({ ...prev, [s.slug]: null }));
                            try {
                              await requestRun({ sessionToken, sourceSlug: s.slug });
                            } catch (err) {
                              setRunRequestErrorBySlug((prev) => ({
                                ...prev,
                                [s.slug]: err instanceof Error ? err.message : String(err)
                              }));
                            } finally {
                              setRunRequestingBySlug((prev) => ({ ...prev, [s.slug]: false }));
                            }
                          }}
                          disabled={
                            !s.enabled || !!activeRunBySourceSlug.get(s.slug) || runRequestingBySlug[s.slug] === true
                          }
                          type="button"
                        >
                          {runRequestingBySlug[s.slug] === true
                            ? "Requesting…"
                            : activeRunBySourceSlug.get(s.slug)?.status === "pending"
                              ? "Queued"
                              : activeRunBySourceSlug.get(s.slug)?.status === "running"
                                ? "Running"
                                : "Run"}
                        </button>
                        {activeRunBySourceSlug.get(s.slug) ? (
                          <button
                            className="text-[11px] text-slate-400 hover:underline"
                            type="button"
                            onClick={() => setSelectedRunId(activeRunBySourceSlug.get(s.slug)!._id)}
                          >
                            View active run <StatusPill status={activeRunBySourceSlug.get(s.slug)!.status} />
                          </button>
                        ) : null}
                        {runRequestErrorBySlug[s.slug] ? (
                          <div className="text-[11px] text-rose-200/90">run error: {runRequestErrorBySlug[s.slug]}</div>
                        ) : null}
                        <ScheduleEditor
                          sourceSlug={s.slug}
                          schedule={schedulesBySourceSlug.get(s.slug) ?? null}
                          sourceEnabled={s.enabled}
                          onSave={(args) => upsertSchedule({ sessionToken, ...args })}
                        />
                      </div>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>

        <div className="rounded-lg border border-slate-800 bg-slate-900/40">
          <div className="border-b border-slate-800 px-4 py-3">
            <div className="text-sm font-medium">Recent runs</div>
          </div>
          <div className="px-4 py-3">
            {runs.length === 0 ? (
              <div className="text-sm text-slate-300">No runs yet.</div>
            ) : (
              <ul className="space-y-2">
                {runs.map((r) => (
                  <li
                    key={r._id}
                    className={`rounded-md border px-3 py-2 ${
                      r._id === selectedRunId
                        ? "border-sky-700 bg-sky-950/30"
                        : "border-slate-800 bg-slate-950/40 hover:border-slate-700"
                    }`}
                    onClick={() => setSelectedRunId(r._id)}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <div className="text-sm">{r.sourceSlug}</div>
                      <StatusPill status={r.status} />
                    </div>
                    <div className="mt-1 text-xs text-slate-400">
                      started {fmtTs(r.startedAt)} · finished {fmtTs(r.completedAt)}
                      {typeof r.productsFound === "number" ? ` · ${r.productsFound} products` : ""}
                    </div>
                    {r.error ? <div className="mt-1 text-xs text-rose-200/90">error: {r.error}</div> : null}
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>

        <div className="rounded-lg border border-slate-800 bg-slate-900/40 md:col-span-2">
          <div className="flex items-center justify-between gap-3 border-b border-slate-800 px-4 py-3">
            <div className="text-sm font-medium">Run log</div>
            <div className="flex items-center gap-3">
              {selectedRun ? (
                <div className="flex items-center gap-2 text-xs text-slate-300">
                  <span className="text-slate-400">{selectedRun.sourceSlug}</span>
                  <StatusPill status={selectedRun.status} />
                  {selectedRun.cancelRequested ? (
                    <span className="rounded-full border border-amber-800 bg-amber-900/30 px-2 py-0.5 text-[11px] text-amber-200">
                      cancel requested
                    </span>
                  ) : null}
                  <span className="text-slate-500">·</span>
                  <span className="text-slate-400">started {fmtTs(selectedRun.startedAt)}</span>
                </div>
              ) : (
                <div className="text-xs text-slate-400">Select a run</div>
              )}

              {selectedRun ? (
                <button
                  className="rounded-md border border-slate-700 bg-slate-900 px-2 py-1 text-xs text-slate-100 hover:bg-slate-800 disabled:opacity-50"
                  type="button"
                  disabled={
                    canceling ||
                    selectedRun.cancelRequested === true ||
                    selectedRun.status === "completed" ||
                    selectedRun.status === "failed" ||
                    selectedRun.status === "canceled"
                  }
                  onClick={async () => {
                    setCanceling(true);
                    setCancelError(null);
                    try {
                      await cancelRun({ sessionToken, runId: selectedRun._id });
                    } catch (err) {
                      setCancelError(err instanceof Error ? err.message : String(err));
                    } finally {
                      setCanceling(false);
                    }
                  }}
                >
                  Cancel
                </button>
              ) : null}
            </div>
          </div>
          <div className="px-4 py-3">
            {cancelError ? <div className="mb-2 text-xs text-rose-200/90">cancel error: {cancelError}</div> : null}
            {selectedRunId && (runLogArtifact || productsJsonArtifact) ? (
              <div className="mb-3 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-slate-300">
                <span className="text-slate-500">artifacts</span>
                {productsJsonArtifact ? (
                  <a
                    className="hover:underline"
                    href={`/media/${productsJsonArtifact.path}`}
                    target="_blank"
                    rel="noreferrer"
                  >
                    products.json
                  </a>
                ) : null}
                {runLogArtifact ? (
                  <a className="hover:underline" href={`/media/${runLogArtifact.path}`} target="_blank" rel="noreferrer">
                    run.log
                  </a>
                ) : null}
              </div>
            ) : null}
            {selectedRunId === null ? (
              <div className="text-sm text-slate-300">No runs yet.</div>
            ) : runEventsChrono.length === 0 ? (
              <div className="text-sm text-slate-300">No events yet.</div>
            ) : (
              <ul className="space-y-1">
                {runEventsChrono.map((e) => {
                  const links =
                    isRecord(e.payload) &&
                    (typeof e.payload.productsJson === "string" || typeof e.payload.runLog === "string")
                      ? {
                          productsJson:
                            typeof e.payload.productsJson === "string" ? e.payload.productsJson : undefined,
                          runLog: typeof e.payload.runLog === "string" ? e.payload.runLog : undefined
                        }
                      : null;

                  return (
                    <li key={e._id} className="rounded border border-slate-800 bg-slate-950/40 px-3 py-2">
                      <div className="text-xs text-slate-200">{eventSummary(e)}</div>
                      {links ? (
                        <div className="mt-1 flex flex-wrap gap-x-4 gap-y-1 text-xs text-slate-300">
                          {links.productsJson ? (
                            <a className="hover:underline" href={links.productsJson} target="_blank" rel="noreferrer">
                              products.json
                            </a>
                          ) : null}
                          {links.runLog ? (
                            <a className="hover:underline" href={links.runLog} target="_blank" rel="noreferrer">
                              run.log
                            </a>
                          ) : null}
                        </div>
                      ) : null}
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        </div>

        <div className="rounded-lg border border-rose-900/60 bg-rose-950/20 md:col-span-2">
          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-rose-900/40 px-4 py-3">
            <div>
              <div className="text-sm font-medium text-rose-200">Danger zone</div>
              <div className="mt-0.5 text-xs text-rose-200/70">
                Deletes products, price points, links, schedules, and runs.
              </div>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <button
                className="rounded-md border border-slate-700 bg-slate-950 px-3 py-1.5 text-xs text-slate-100 hover:bg-slate-900/40 disabled:opacity-50"
                type="button"
                disabled={backfilling}
                onClick={async () => {
                  if (backfilling) return;
                  if (!window.confirm("Backfill productsLatest.lastSeenRunId from each source's lastSuccessfulRunId?"))
                    return;
                  setBackfilling(true);
                  setBackfillError(null);
                  setBackfillResult(null);
                  try {
                    const result = await backfillProductsLatestLastSeenRunId({ sessionToken, batchSize: 500 });
                    setBackfillResult(result);
                  } catch (err) {
                    setBackfillError(err instanceof Error ? err.message : String(err));
                  } finally {
                    setBackfilling(false);
                  }
                }}
              >
                {backfilling ? "Backfilling…" : "Backfill lastSeenRunIds"}
              </button>
              <button
                className="rounded-md border border-rose-800 bg-rose-950 px-3 py-1.5 text-xs text-rose-100 hover:bg-rose-900/40 disabled:opacity-50"
                type="button"
                disabled={resetting}
                onClick={async () => {
                  if (resetting) return;
                  if (!window.confirm("Reset all Convex data? This cannot be undone.")) return;
                  if (!window.confirm("This will delete runs, products, and links. Are you absolutely sure?")) return;
                  setResetting(true);
                  setResetError(null);
                  setResetResult(null);
                  try {
                    const result = await resetAll({ sessionToken, deleteSchedules: true });
                    setResetResult(result);
                  } catch (err) {
                    setResetError(err instanceof Error ? err.message : String(err));
                  } finally {
                    setResetting(false);
                  }
                }}
              >
                Reset everything
              </button>
            </div>
          </div>
          <div className="px-4 py-3">
            {backfillError ? <div className="mb-2 text-xs text-rose-200/90">backfill error: {backfillError}</div> : null}
            {backfillResult ? (
              <pre className="mb-3 overflow-auto rounded border border-slate-800 bg-slate-950/40 p-3 text-[11px] text-slate-100/90">
                {JSON.stringify(backfillResult, null, 2)}
              </pre>
            ) : null}
            {resetError ? <div className="text-xs text-rose-200/90">reset error: {resetError}</div> : null}
            {resetResult ? (
              <pre className="overflow-auto rounded border border-rose-900/40 bg-rose-950/30 p-3 text-[11px] text-rose-100/90">
                {JSON.stringify(resetResult, null, 2)}
              </pre>
            ) : (
              <div className="text-xs text-rose-200/70">Tip: use “Seed demo” after a reset to restore the demo sources.</div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

