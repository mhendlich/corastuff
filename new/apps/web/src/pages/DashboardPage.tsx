import { useAction, useMutation, useQuery } from "convex/react";
import { useEffect, useMemo, useState } from "react";
import { CodeHighlight } from "@mantine/code-highlight";
import { Carousel } from "@mantine/carousel";
import {
  Accordion,
  ActionIcon,
  Anchor,
  Badge,
  Button,
  Container,
  Divider,
  Group,
  Image,
  Loader,
  ScrollArea,
  SimpleGrid,
  Stack,
  Text,
  Title,
  Tooltip
} from "@mantine/core";
import { Dropzone } from "@mantine/dropzone";
import { modals } from "@mantine/modals";
import { notifications } from "@mantine/notifications";
import {
  IconBolt,
  IconCircleX,
  IconDatabaseImport,
  IconBraces,
  IconFileText,
  IconPhoto,
  IconRefresh,
  IconX
} from "@tabler/icons-react";
import { MetricTile } from "../components/MetricTile";
import { Panel } from "../components/Panel";
import { RunRow } from "../features/dashboard/components/RunRow";
import { SourceCard } from "../features/dashboard/components/SourceCard";
import { eventSummary, isRecord } from "../features/dashboard/utils";
import { fmtTs } from "../lib/time";
import text from "../ui/text.module.css";
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
  type RunsRequestAllResult,
  type SourceLastScrape
} from "../convexFns";

export function DashboardPage(props: { sessionToken: string }) {
  const { sessionToken } = props;

  const sources = useQuery(sourcesList, { sessionToken }) ?? [];
  const stats: DashboardStats | null = useQuery(dashboardStats, { sessionToken }) ?? null;
  const lastScrapes: SourceLastScrape[] = useQuery(dashboardLastScrapes, { sessionToken }) ?? [];
  const activeRuns = useQuery(runsListActive, { sessionToken }) ?? [];
  const runs = useQuery(runsListRecent, { sessionToken, limit: 20 }) ?? [];
  const schedules = useQuery(schedulesList, { sessionToken }) ?? [];

  const skip = "skip" as const;

  const linkCounts =
    useQuery(linksCountsBySource, sources.length > 0 ? { sessionToken, sourceSlugs: sources.map((s) => s.slug) } : skip) ??
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
    if (!selectedRunId && runs.length > 0) setSelectedRunId(runs[0]!._id);
  }, [selectedRunId, runs]);

  const runEvents = useQuery(runsListEvents, selectedRunId ? { sessionToken, runId: selectedRunId, limit: 80 } : skip) ?? [];

  const runArtifacts = useQuery(runArtifactsListForRun, selectedRunId ? { sessionToken, runId: selectedRunId } : skip) ?? [];

  const selectedRun = selectedRunId ? runs.find((r) => r._id === selectedRunId) ?? null : null;
  const runEventsChrono = useMemo(() => [...runEvents].reverse(), [runEvents]);

  const schedulesBySourceSlug = useMemo(() => new Map(schedules.map((s) => [s.sourceSlug, s])), [schedules]);
  const countsBySourceSlug = useMemo(
    () => new Map<string, LinkCountsBySource>(linkCounts.map((c) => [c.sourceSlug, c])),
    [linkCounts]
  );
  const lastScrapeBySourceSlug = useMemo(
    () => new Map<string, SourceLastScrape>(lastScrapes.map((s) => [s.sourceSlug, s])),
    [lastScrapes]
  );

  const activeRunBySourceSlug = useMemo(() => {
    const map = new Map<string, (typeof activeRuns)[number]>();
    for (const run of activeRuns) {
      if (!map.has(run.sourceSlug)) map.set(run.sourceSlug, run);
    }
    return map;
  }, [activeRuns]);

  const screenshotArtifacts = useMemo(
    () =>
      runArtifacts.filter(
        (a) => a.type === "screenshot" || /\.(png|jpe?g|webp|gif)$/i.test(a.path) || a.key.toLowerCase().includes("screenshot")
      ),
    [runArtifacts]
  );

  const [localArtifact, setLocalArtifact] = useState<
    | {
        name: string;
        kind: "json" | "text";
        text: string;
        json?: unknown;
        error?: string;
      }
    | null
  >(null);
  useEffect(() => setLocalArtifact(null), [selectedRunId]);

  const [runRequestingBySlug, setRunRequestingBySlug] = useState<Record<string, boolean>>({});
  const [runRequestErrorBySlug, setRunRequestErrorBySlug] = useState<Record<string, string | null>>({});

  const [runAlling, setRunAlling] = useState(false);
  const [runAllError, setRunAllError] = useState<string | null>(null);
  const [runAllResult, setRunAllResult] = useState<RunsRequestAllResult | null>(null);

  const [canceling, setCanceling] = useState(false);
  const [cancelError, setCancelError] = useState<string | null>(null);

  const [resetting, setResetting] = useState(false);
  const [resetResult, setResetResult] = useState<ResetAllResult | null>(null);
  const [resetError, setResetError] = useState<string | null>(null);

  const [backfilling, setBackfilling] = useState(false);
  const [backfillError, setBackfillError] = useState<string | null>(null);
  const [backfillResult, setBackfillResult] = useState<BackfillProductsLatestLastSeenRunIdResult | null>(null);

  return (
    <Container size="xl" py="xl">
      <Stack gap="lg">
        <SimpleGrid cols={{ base: 2, md: 3, lg: 5 }} spacing="md">
          <MetricTile label="Sources" value={stats ? String(stats.sources) : "—"} size="lg" />
          <MetricTile label="Canonicals" value={stats ? String(stats.canonicalProducts) : "—"} size="lg" />
          <MetricTile label="Linked" value={stats ? String(stats.linkedProducts) : "—"} size="lg" />
          <MetricTile label="Unlinked" value={stats ? String(stats.unlinkedProducts) : "—"} size="lg" />
          <MetricTile label="Source products" value={stats ? String(stats.totalProducts) : "—"} size="lg" />
        </SimpleGrid>

        <SimpleGrid cols={{ base: 1, lg: 2 }} spacing="md">
          <Panel>
            <Group justify="space-between" align="flex-start" wrap="wrap" gap="md">
              <div>
                <Title order={4}>Sources</Title>
                <Text size="sm" c="dimmed">
                  Enable sources, schedule scrapes, and run on demand.
                </Text>
              </div>

              <Group gap="sm">
                <Button
                  leftSection={<IconDatabaseImport size={16} />}
                  variant="light"
                  onClick={async () => {
                    try {
                      await seedDemo({ sessionToken });
                      notifications.show({ title: "Seeded demo", message: "Demo sources added." });
                    } catch (err) {
                      notifications.show({
                        title: "Seed failed",
                        message: err instanceof Error ? err.message : String(err),
                        color: "red"
                      });
                    }
                  }}
                >
                  Seed demo
                </Button>

                <Button
                  leftSection={<IconBolt size={16} />}
                  variant="filled"
                  loading={runAlling}
                  disabled={sources.every((s) => s.enabled !== true)}
                  onClick={async () => {
                    setRunAlling(true);
                    setRunAllError(null);
                    setRunAllResult(null);
                    try {
                      const result = await requestAllRuns({ sessionToken });
                      setRunAllResult(result);
                      const firstOk = result.results.find((r) => r.ok && typeof r.runId === "string");
                      if (firstOk?.runId) setSelectedRunId(firstOk.runId);
                      notifications.show({ title: "Queued runs", message: "Requested runs for enabled sources." });
                    } catch (err) {
                      setRunAllError(err instanceof Error ? err.message : String(err));
                    } finally {
                      setRunAlling(false);
                    }
                  }}
                >
                  Run all enabled
                </Button>
              </Group>
            </Group>

            {runAllError ? (
              <Text c="red.2" size="sm" mt="md">
                run-all error: {runAllError}
              </Text>
            ) : null}

            {runAllResult ? (
              <Panel variant="subtle" radius="md" p="md" mt="md">
                <Text size="xs" c="dimmed" fw={700} tt="uppercase" className={text.tracking}>
                  Run all result
                </Text>
                <CodeHighlight
                  mt={8}
                  code={JSON.stringify(runAllResult, null, 2)}
                  language="json"
                  withCopyButton
                  withExpandButton
                />
              </Panel>
            ) : null}

            <Stack gap="md" mt="lg">
              {sources.length === 0 ? (
                <Text c="dimmed">No sources yet.</Text>
              ) : (
                sources.map((source) => (
                  <SourceCard
                    key={source._id}
                    source={source}
                    counts={countsBySourceSlug.get(source.slug) ?? null}
                    lastScrape={lastScrapeBySourceSlug.get(source.slug) ?? null}
                    schedule={schedulesBySourceSlug.get(source.slug) ?? null}
                    activeRun={
                      activeRunBySourceSlug.get(source.slug)
                        ? {
                            runId: activeRunBySourceSlug.get(source.slug)!._id,
                            status: activeRunBySourceSlug.get(source.slug)!.status
                          }
                        : null
                    }
                    onEnable={(args) => setSourceEnabled({ sessionToken, ...args })}
                    onSaveSchedule={(args) => upsertSchedule({ sessionToken, ...args })}
                    runLoading={runRequestingBySlug[source.slug] === true}
                    runError={runRequestErrorBySlug[source.slug] ?? null}
                    onRun={async () => {
                      setRunRequestingBySlug((m) => ({ ...m, [source.slug]: true }));
                      setRunRequestErrorBySlug((m) => ({ ...m, [source.slug]: null }));
                      try {
                        const result = await requestRun({ sessionToken, sourceSlug: source.slug });
                        setSelectedRunId(result.runId);
                        notifications.show({ title: "Run queued", message: `${source.slug} run requested` });
                      } catch (err) {
                        setRunRequestErrorBySlug((m) => ({
                          ...m,
                          [source.slug]: err instanceof Error ? err.message : String(err)
                        }));
                      } finally {
                        setRunRequestingBySlug((m) => ({ ...m, [source.slug]: false }));
                      }
                    }}
                  />
                ))
              )}
            </Stack>
          </Panel>

          <Stack gap="md">
            <Panel>
              <Group justify="space-between">
                <div>
                  <Title order={4}>Recent runs</Title>
                  <Text size="sm" c="dimmed">
                    Select a run to inspect events and artifacts.
                  </Text>
                </div>
                <Badge variant="light" color="gray">
                  {runs.length}
                </Badge>
              </Group>
              <Divider my="md" />

              {runs.length === 0 ? (
                <Text c="dimmed">No runs yet.</Text>
              ) : (
                <ScrollArea h={420} offsetScrollbars scrollbarSize={8}>
                  <Stack gap="sm">
                    {runs.map((run) => (
                      <RunRow
                        key={run._id}
                        run={run}
                        selected={run._id === selectedRunId}
                        onSelect={() => setSelectedRunId(run._id)}
                      />
                    ))}
                  </Stack>
                </ScrollArea>
              )}
            </Panel>

            <Panel>
              <Group justify="space-between" align="flex-start" wrap="wrap">
                <div>
                  <Title order={4}>Run log</Title>
                  <Text size="sm" c="dimmed">
                    {selectedRun ? `${selectedRun.sourceSlug} · started ${fmtTs(selectedRun.startedAt)}` : "Select a run"}
                  </Text>
                </div>

                {selectedRun ? (
                  <Group gap="sm">
                    {selectedRun.cancelRequested ? (
                      <Badge variant="light" color="yellow">
                        cancel requested
                      </Badge>
                    ) : null}
                    <Tooltip label="Cancel run" withArrow>
                      <ActionIcon
                        variant="default"
                        size="lg"
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
                            notifications.show({ title: "Cancel requested", message: `${selectedRun.sourceSlug}` });
                          } catch (err) {
                            setCancelError(err instanceof Error ? err.message : String(err));
                          } finally {
                            setCanceling(false);
                          }
                        }}
                      >
                        {canceling ? <Loader size={18} /> : <IconCircleX size={18} />}
                      </ActionIcon>
                    </Tooltip>
                  </Group>
                ) : null}
              </Group>

              {cancelError ? (
                <Text c="red.2" size="sm" mt="md">
                  cancel error: {cancelError}
                </Text>
              ) : null}

              {selectedRunId && runArtifacts.length > 0 ? (
                <Accordion variant="separated" mt="md">
                  <Accordion.Item value="artifacts">
                    <Accordion.Control>
                      <Group justify="space-between" wrap="nowrap" gap="md">
                        <Group gap="xs" wrap="nowrap">
                          <Text size="xs" c="dimmed" fw={700} tt="uppercase" className={text.tracking}>
                            Artifacts
                          </Text>
                          <Badge variant="light" color="gray" radius="xl">
                            {runArtifacts.length}
                          </Badge>
                        </Group>
                        <Text size="xs" c="dimmed" visibleFrom="sm">
                          Click to preview
                        </Text>
                      </Group>
                    </Accordion.Control>
                    <Accordion.Panel>
                      <Group gap="sm" wrap="wrap">
                        {runArtifacts.map((a) => {
                          const href = `/media/${a.path}`;
                          const left =
                            a.type === "screenshot" || /\.(png|jpe?g|webp|gif)$/i.test(a.path) ? (
                              <IconPhoto size={14} />
                            ) : a.type === "json" || a.key.endsWith(".json") ? (
                              <IconBraces size={14} />
                            ) : (
                              <IconFileText size={14} />
                            );
                          return (
                            <Anchor key={a._id} href={href} target="_blank" rel="noreferrer" size="sm">
                              <Group gap={6} wrap="nowrap">
                                {left}
                                <Text component="span" inherit className={text.mono}>
                                  {a.key}
                                </Text>
                              </Group>
                            </Anchor>
                          );
                        })}
                      </Group>

                      {screenshotArtifacts.length > 0 ? (
                        <Carousel
                          mt="md"
                          slideSize={{ base: "100%", md: "70%" }}
                          slideGap="md"
                          withIndicators
                          height={360}
                        >
                          {screenshotArtifacts.map((a) => (
                            <Carousel.Slide key={a._id}>
                              <Anchor href={`/media/${a.path}`} target="_blank" rel="noreferrer">
                                <Image
                                  src={`/media/${a.path}`}
                                  alt={a.key}
                                  radius="md"
                                  h={360}
                                  fit="contain"
                                  styles={{ root: { background: "color-mix(in srgb, var(--mantine-color-dark-9) 40%, transparent)" } }}
                                />
                              </Anchor>
                            </Carousel.Slide>
                          ))}
                        </Carousel>
                      ) : null}
                    </Accordion.Panel>
                  </Accordion.Item>

                  <Accordion.Item value="inspect-local">
                    <Accordion.Control>
                      <Group justify="space-between" wrap="nowrap" gap="md">
                        <Group gap="xs" wrap="nowrap">
                          <Text size="xs" c="dimmed" fw={700} tt="uppercase" className={text.tracking}>
                            Inspect local file
                          </Text>
                        </Group>
                        <Text size="xs" c="dimmed" visibleFrom="sm">
                          Drop `products.json` or `run.log`
                        </Text>
                      </Group>
                    </Accordion.Control>
                    <Accordion.Panel>
                      <Dropzone
                        maxFiles={1}
                        onDrop={async (files) => {
                          const f = files[0];
                          if (!f) return;
                          const text = (await f.text()).slice(0, 600_000);
                          const kind: "json" | "text" = f.name.endsWith(".json") ? "json" : "text";
                          if (kind === "json") {
                            try {
                              const json = JSON.parse(text);
                              setLocalArtifact({ name: f.name, kind, text, json });
                            } catch (err) {
                              setLocalArtifact({
                                name: f.name,
                                kind,
                                text,
                                error: err instanceof Error ? err.message : String(err)
                              });
                            }
                          } else {
                            setLocalArtifact({ name: f.name, kind, text });
                          }
                        }}
                        onReject={() => setLocalArtifact(null)}
                        accept={[
                          "application/json",
                          "text/plain",
                          "application/octet-stream",
                          "text/*"
                        ]}
                      >
                        <Group justify="center" gap="md" style={{ minHeight: 96 }}>
                          <Text size="sm" c="dimmed">
                            Drag & drop a file here, or click to select
                          </Text>
                        </Group>
                      </Dropzone>

                      {localArtifact ? (
                        <Stack gap="sm" mt="md">
                          <Group justify="space-between" wrap="wrap">
                            <Text size="sm" fw={700}>
                              {localArtifact.name}
                            </Text>
                            {localArtifact.error ? (
                              <Badge variant="light" color="red">
                                parse error
                              </Badge>
                            ) : localArtifact.kind === "json" ? (
                              <Badge variant="light" color="gray">
                                json
                              </Badge>
                            ) : (
                              <Badge variant="light" color="gray">
                                text
                              </Badge>
                            )}
                          </Group>

                          {localArtifact.kind === "json" && localArtifact.json && !localArtifact.error ? (
                            <Panel variant="subtle" radius="md" p="md">
                              <SimpleGrid cols={{ base: 2, md: 4 }} spacing="md">
                                <MetricTile
                                  label="Top-level"
                                  value={Array.isArray(localArtifact.json) ? "array" : typeof localArtifact.json}
                                  size="sm"
                                />
                                <MetricTile
                                  label="Items"
                                  value={Array.isArray(localArtifact.json) ? String(localArtifact.json.length) : "—"}
                                  size="sm"
                                />
                                <MetricTile
                                  label="Bytes (truncated)"
                                  value={String(localArtifact.text.length)}
                                  size="sm"
                                />
                                <MetricTile label="Kind" value={localArtifact.kind} size="sm" />
                              </SimpleGrid>
                            </Panel>
                          ) : null}

                          <CodeHighlight
                            code={
                              localArtifact.kind === "json"
                                ? localArtifact.error
                                  ? localArtifact.text
                                  : JSON.stringify(localArtifact.json ?? null, null, 2)
                                : localArtifact.text
                            }
                            language={localArtifact.kind === "json" ? "json" : "text"}
                            withCopyButton
                            withExpandButton
                            maxCollapsedHeight={240}
                          />
                        </Stack>
                      ) : null}
                    </Accordion.Panel>
                  </Accordion.Item>
                </Accordion>
              ) : null}

              <Divider my="md" />

              {selectedRunId === null ? (
                <Text c="dimmed">No runs yet.</Text>
              ) : runEventsChrono.length === 0 ? (
                <Text c="dimmed">No events yet.</Text>
              ) : (
                <ScrollArea h={520} offsetScrollbars scrollbarSize={8}>
                  <Accordion variant="separated" multiple>
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

                      const levelColor =
                        e.level === "error"
                          ? "red"
                          : e.level === "warn"
                            ? "yellow"
                            : e.level === "debug"
                              ? "gray"
                              : "cyan";

                      const payloadCode =
                        typeof e.payload === "string" ? e.payload : JSON.stringify(e.payload, null, 2);

                      const payloadLang = typeof e.payload === "string" ? "text" : "json";

                      return (
                        <Accordion.Item key={e._id} value={e._id}>
                          <Accordion.Control>
                            <Group justify="space-between" align="flex-start" wrap="nowrap" gap="md">
                              <Text size="sm" className={text.mono} style={{ minWidth: 0 }}>
                                {eventSummary(e)}
                              </Text>
                              <Badge variant="light" color={levelColor} radius="xl">
                                {e.level}
                              </Badge>
                            </Group>
                          </Accordion.Control>
                          <Accordion.Panel>
                            {links ? (
                              <Group gap="md" mb="sm">
                                {links.productsJson ? (
                                  <Anchor href={links.productsJson} target="_blank" rel="noreferrer" size="sm">
                                    products.json
                                  </Anchor>
                                ) : null}
                                {links.runLog ? (
                                  <Anchor href={links.runLog} target="_blank" rel="noreferrer" size="sm">
                                    run.log
                                  </Anchor>
                                ) : null}
                              </Group>
                            ) : null}

                            <CodeHighlight
                              code={payloadCode}
                              language={payloadLang}
                              withCopyButton
                              withExpandButton
                              maxCollapsedHeight={220}
                            />
                          </Accordion.Panel>
                        </Accordion.Item>
                      );
                    })}
                  </Accordion>
                </ScrollArea>
              )}
            </Panel>

            <Panel variant="danger">
              <Group justify="space-between" align="flex-start" wrap="wrap">
                <div>
                  <Title order={4} c="red.2">
                    Danger zone
                  </Title>
                  <Text size="sm" c="red.2" opacity={0.85}>
                    Deletes products, price points, links, schedules, and runs.
                  </Text>
                </div>
                <Group gap="sm">
                  <Button
                    variant="default"
                    color="red"
                    leftSection={<IconRefresh size={16} />}
                    loading={backfilling}
                    onClick={() => {
                      if (backfilling) return;
                      modals.openConfirmModal({
                        title: "Backfill lastSeenRunIds?",
                        centered: true,
                        labels: { confirm: "Backfill", cancel: "Cancel" },
                        confirmProps: { color: "red" },
                        children: (
                          <Text size="sm">
                            Backfill <Text component="span" className={text.mono} inherit>productsLatest.lastSeenRunId</Text>{" "}
                            from each source&apos;s last successful run. This should be safe but may touch lots of rows.
                          </Text>
                        ),
                        onConfirm: () => {
                          void (async () => {
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
                          })();
                        }
                      });
                    }}
                  >
                    Backfill lastSeenRunIds
                  </Button>
                  <Button
                    variant="filled"
                    color="red"
                    leftSection={<IconX size={16} />}
                    loading={resetting}
                    onClick={() => {
                      if (resetting) return;
                      modals.openConfirmModal({
                        title: "Reset everything?",
                        centered: true,
                        labels: { confirm: "Reset", cancel: "Cancel" },
                        confirmProps: { color: "red" },
                        children: (
                          <Stack gap={8}>
                            <Text size="sm">This will delete runs, products, price points, links and schedules.</Text>
                            <Text size="xs" c="dimmed">
                              There is no undo.
                            </Text>
                          </Stack>
                        ),
                        onConfirm: () => {
                          void (async () => {
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
                          })();
                        }
                      });
                    }}
                  >
                    Reset everything
                  </Button>
                </Group>
              </Group>

              {backfillError ? (
                <Text c="red.2" size="sm" mt="md">
                  backfill error: {backfillError}
                </Text>
              ) : null}
              {backfillResult ? (
                <CodeHighlight
                  mt="md"
                  code={JSON.stringify(backfillResult, null, 2)}
                  language="json"
                  withCopyButton
                  withExpandButton
                />
              ) : null}

              {resetError ? (
                <Text c="red.2" size="sm" mt="md">
                  reset error: {resetError}
                </Text>
              ) : null}
              {resetResult ? (
                <CodeHighlight
                  mt="md"
                  code={JSON.stringify(resetResult, null, 2)}
                  language="json"
                  withCopyButton
                  withExpandButton
                />
              ) : (
                <Text size="xs" c="dimmed" mt="md">
                  Tip: use “Seed demo” after a reset to restore the demo sources.
                </Text>
              )}
            </Panel>
          </Stack>
        </SimpleGrid>
      </Stack>
    </Container>
  );
}
