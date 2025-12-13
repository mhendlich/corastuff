import { useAction, useMutation, useQuery } from "convex/react";
import { useEffect, useMemo, useState } from "react";
import {
  Badge,
  Button,
  Container,
  Divider,
  Grid,
  Group,
  Loader,
  NumberInput,
  Paper,
  SimpleGrid,
  Stack,
  Switch,
  Table,
  Text
} from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { IconDeviceFloppy, IconPlayerPause, IconPlayerPlay, IconRefresh } from "@tabler/icons-react";
import { MetricTile } from "../components/MetricTile";
import { fmtAgo, fmtTs } from "../lib/time";
import text from "../ui/text.module.css";
import {
  automationPause,
  automationResume,
  automationStatus,
  dashboardLastScrapes,
  runsListActive,
  schedulesList,
  schedulesUpsert,
  settingsGetScraperConcurrencyLimit,
  settingsSetScraperConcurrencyLimit,
  sourcesList,
  type ScheduleDoc,
  type SourceLastScrape
} from "../convexFns";
import classes from "./ScraperSchedulesPage.module.css";

type ScheduleDraft = { enabled: boolean; intervalMinutes: number };
const DEFAULT_INTERVAL_MINUTES = 60;

function boolEq(a: boolean, b: boolean) {
  return a === b;
}

function scheduleEq(a: ScheduleDraft, b: ScheduleDraft) {
  return boolEq(a.enabled, b.enabled) && a.intervalMinutes === b.intervalMinutes;
}

export function ScraperSchedulesPage(props: { sessionToken: string }) {
  const { sessionToken } = props;
  const sources = useQuery(sourcesList, { sessionToken }) ?? [];
  const schedules = useQuery(schedulesList, { sessionToken }) ?? [];
  const lastScrapes: SourceLastScrape[] = useQuery(dashboardLastScrapes, { sessionToken }) ?? [];
  const activeRuns = useQuery(runsListActive, { sessionToken }) ?? [];

  const concurrencyLimit = useQuery(settingsGetScraperConcurrencyLimit, { sessionToken });
  const saveConcurrencyLimit = useMutation(settingsSetScraperConcurrencyLimit);

  const upsertSchedule = useAction(schedulesUpsert);
  const fetchAutomationStatus = useAction(automationStatus);
  const pauseAutomation = useAction(automationPause);
  const resumeAutomation = useAction(automationResume);

  const schedulesBySlug = useMemo(() => new Map(schedules.map((s) => [s.sourceSlug, s])), [schedules]);
  const lastBySlug = useMemo(() => new Map(lastScrapes.map((s) => [s.sourceSlug, s])), [lastScrapes]);

  const currentBySlug = useMemo(() => {
    const out = new Map<string, ScheduleDraft>();
    for (const source of sources) {
      const schedule = schedulesBySlug.get(source.slug);
      out.set(source.slug, {
        enabled: schedule?.enabled ?? false,
        intervalMinutes: schedule?.intervalMinutes ?? DEFAULT_INTERVAL_MINUTES
      });
    }
    return out;
  }, [sources, schedulesBySlug]);

  const [draftBySlug, setDraftBySlug] = useState<Record<string, ScheduleDraft>>({});

  useEffect(() => {
    if (sources.length === 0) return;
    setDraftBySlug((prev) => {
      let changed = false;
      const next: Record<string, ScheduleDraft> = { ...prev };
      for (const source of sources) {
        const current = currentBySlug.get(source.slug);
        if (!current) continue;
        const existing = next[source.slug];
        const dirty = existing ? !scheduleEq(existing, current) : false;
        if (!existing || !dirty) {
          next[source.slug] = { ...current };
          changed = true;
        }
      }
      return changed ? next : prev;
    });
  }, [sources, currentBySlug]);

  const dirtySlugs = useMemo(() => {
    const out: string[] = [];
    for (const source of sources) {
      const current = currentBySlug.get(source.slug);
      const draft = draftBySlug[source.slug];
      if (!current || !draft) continue;
      if (!scheduleEq(current, draft)) out.push(source.slug);
    }
    return out;
  }, [sources, currentBySlug, draftBySlug]);

  const dirtyCount = dirtySlugs.length;

  const enabledCount = useMemo(() => {
    let count = 0;
    for (const source of sources) {
      const d = draftBySlug[source.slug];
      if (d?.enabled) count += 1;
    }
    return count;
  }, [sources, draftBySlug]);

  const [bulkInterval, setBulkInterval] = useState<number | "">(DEFAULT_INTERVAL_MINUTES);
  const [saving, setSaving] = useState(false);

  const [automationPaused, setAutomationPaused] = useState<boolean | null>(null);
  const [automationBusy, setAutomationBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const tick = async () => {
      try {
        const s = await fetchAutomationStatus({ sessionToken });
        if (!cancelled) setAutomationPaused(s.paused);
      } catch (err) {
        if (!cancelled) setAutomationPaused(null);
      }
    };
    void tick();
    const id = window.setInterval(() => void tick(), 5000);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [fetchAutomationStatus, sessionToken]);

  const [concurrencyDraft, setConcurrencyDraft] = useState<number>(10);
  const [concurrencyTouched, setConcurrencyTouched] = useState(false);

  useEffect(() => {
    if (typeof concurrencyLimit !== "number" || !Number.isFinite(concurrencyLimit)) return;
    if (concurrencyTouched) return;
    setConcurrencyDraft(Math.max(1, Math.min(100, Math.trunc(concurrencyLimit))));
  }, [concurrencyLimit, concurrencyTouched]);

  const anyLoading = sources.length === 0 && schedules.length === 0;

  return (
    <Container size="xl" py="xl">
      <Stack gap="lg">
        <Group justify="space-between" align="flex-end" wrap="wrap" gap="md">
          <Stack gap={4}>
            <Text fw={750}>Automation</Text>
            <Text c="dimmed" size="sm">
              Control schedules and scraper concurrency.
            </Text>
          </Stack>
        </Group>

        <Grid gutter="lg">
          <Grid.Col span={{ base: 12, md: 4 }}>
            <Stack gap="md">
              <Paper withBorder radius="lg" p="md">
                <Stack gap="sm">
                  <Group justify="space-between" align="flex-start" wrap="nowrap">
                    <Stack gap={2} style={{ flex: 1 }}>
                      <Text fw={700} size="sm">
                        Scheduler status
                      </Text>
                      <Text c="dimmed" size="xs">
                        Scheduled jobs are skipped when paused; manual runs still work.
                      </Text>
                    </Stack>
                    <Group gap="xs">
                      <Button
                        size="xs"
                        variant="default"
                        leftSection={<IconRefresh size={14} />}
                        onClick={async () => {
                          try {
                            const s = await fetchAutomationStatus({ sessionToken });
                            setAutomationPaused(s.paused);
                          } catch (err) {
                            notifications.show({
                              title: "Refresh failed",
                              message: err instanceof Error ? err.message : String(err),
                              color: "red"
                            });
                          }
                        }}
                      >
                        Refresh
                      </Button>
                    </Group>
                  </Group>

                  <Group justify="space-between" align="center">
                    <Group gap="sm">
                      {automationPaused === null ? (
                        <Badge variant="light" color="gray" radius="xl">
                          <Group gap="xs">
                            <Loader size={12} />
                            <span>Unknown</span>
                          </Group>
                        </Badge>
                      ) : automationPaused ? (
                        <Badge variant="light" color="yellow" radius="xl">
                          Paused
                        </Badge>
                      ) : (
                        <Badge variant="light" color="teal" radius="xl">
                          Running
                        </Badge>
                      )}
                      <Text size="xs" c="dimmed">
                        active runs <span className={text.mono}>{activeRuns.length}</span>
                      </Text>
                    </Group>

                    <Button
                      size="xs"
                      variant={automationPaused ? "filled" : "default"}
                      color={automationPaused ? "teal" : "yellow"}
                      leftSection={automationPaused ? <IconPlayerPlay size={14} /> : <IconPlayerPause size={14} />}
                      loading={automationBusy}
                      onClick={async () => {
                        setAutomationBusy(true);
                        try {
                          const s = automationPaused
                            ? await resumeAutomation({ sessionToken })
                            : await pauseAutomation({ sessionToken });
                          setAutomationPaused(s.paused);
                          notifications.show({
                            title: s.paused ? "Automation paused" : "Automation resumed",
                            message: "Applied globally for scheduled runs."
                          });
                        } catch (err) {
                          notifications.show({
                            title: "Update failed",
                            message: err instanceof Error ? err.message : String(err),
                            color: "red"
                          });
                        } finally {
                          setAutomationBusy(false);
                        }
                      }}
                    >
                      {automationPaused ? "Resume" : "Pause"}
                    </Button>
                  </Group>
                </Stack>
              </Paper>

              <Paper withBorder radius="lg" p="md">
                <Stack gap="sm">
                  <Stack gap={2}>
                    <Text fw={700} size="sm">
                      Bulk controls
                    </Text>
                    <Text c="dimmed" size="xs">
                      Apply changes locally, then save all schedules at once.
                    </Text>
                  </Stack>

                  <Group gap="sm" wrap="wrap">
                    <Button
                      size="xs"
                      variant="default"
                      onClick={() => {
                        setDraftBySlug((prev) => {
                          const next = { ...prev };
                          for (const s of sources) {
                            const current = next[s.slug] ?? currentBySlug.get(s.slug);
                            if (!current) continue;
                            next[s.slug] = { ...current, enabled: true };
                          }
                          return next;
                        });
                      }}
                      disabled={sources.length === 0}
                    >
                      Enable all
                    </Button>
                    <Button
                      size="xs"
                      variant="default"
                      onClick={() => {
                        setDraftBySlug((prev) => {
                          const next = { ...prev };
                          for (const s of sources) {
                            const current = next[s.slug] ?? currentBySlug.get(s.slug);
                            if (!current) continue;
                            next[s.slug] = { ...current, enabled: false };
                          }
                          return next;
                        });
                      }}
                      disabled={sources.length === 0}
                    >
                      Disable all
                    </Button>
                  </Group>

                  <Group gap="sm" align="flex-end" wrap="nowrap">
                    <NumberInput
                      label="Interval (minutes)"
                      description="Applies to all rows"
                      value={bulkInterval}
                      onChange={(value) => {
                        if (typeof value === "number") setBulkInterval(value);
                        else setBulkInterval("");
                      }}
                      min={1}
                      max={10_080}
                      clampBehavior="strict"
                      allowDecimal={false}
                      allowNegative={false}
                      allowLeadingZeros={false}
                      styles={{ root: { flex: 1 } }}
                    />
                    <Button
                      size="xs"
                      variant="default"
                      onClick={() => {
                        const val = typeof bulkInterval === "number" ? Math.max(1, Math.min(10_080, Math.trunc(bulkInterval))) : null;
                        if (!val) return;
                        setDraftBySlug((prev) => {
                          const next = { ...prev };
                          for (const s of sources) {
                            const current = next[s.slug] ?? currentBySlug.get(s.slug);
                            if (!current) continue;
                            next[s.slug] = { ...current, intervalMinutes: val };
                          }
                          return next;
                        });
                      }}
                      disabled={typeof bulkInterval !== "number" || sources.length === 0}
                    >
                      Apply
                    </Button>
                  </Group>
                </Stack>
              </Paper>

              <Paper withBorder radius="lg" p="md">
                <Stack gap="sm">
                  <Stack gap={2}>
                    <Text fw={700} size="sm">
                      Concurrency
                    </Text>
                    <Text c="dimmed" size="xs">
                      Caps how many scrapers can run at the same time (applies after worker restart).
                    </Text>
                  </Stack>

                  <Group gap="sm" align="flex-end" wrap="nowrap">
                    <NumberInput
                      label="Max concurrent scrapers"
                      value={concurrencyDraft}
                      onChange={(v) => {
                        const n = typeof v === "number" ? v : Number.NaN;
                        setConcurrencyTouched(true);
                        if (!Number.isFinite(n)) return;
                        setConcurrencyDraft(Math.max(1, Math.min(100, Math.trunc(n))));
                      }}
                      min={1}
                      max={100}
                      allowDecimal={false}
                      allowNegative={false}
                      clampBehavior="strict"
                      styles={{ root: { flex: 1 } }}
                    />
                    <Button
                      size="xs"
                      leftSection={<IconDeviceFloppy size={14} />}
                      onClick={async () => {
                        try {
                          const limit = Math.max(1, Math.min(100, Math.trunc(concurrencyDraft)));
                          const result = await saveConcurrencyLimit({ sessionToken, limit });
                          notifications.show({
                            title: "Saved concurrency limit",
                            message: `max concurrent scrapers = ${result.limit}`
                          });
                          setConcurrencyTouched(false);
                        } catch (err) {
                          notifications.show({
                            title: "Save failed",
                            message: err instanceof Error ? err.message : String(err),
                            color: "red"
                          });
                        }
                      }}
                    >
                      Save
                    </Button>
                  </Group>
                </Stack>
              </Paper>
            </Stack>
          </Grid.Col>

          <Grid.Col span={{ base: 12, md: 8 }}>
            <Stack gap="md">
              <SimpleGrid cols={{ base: 1, sm: 3 }} spacing="md">
                <MetricTile label="Scrapers" value={sources.length} tone="neutral" size="sm" />
                <MetricTile label="Enabled schedules" value={enabledCount} tone="brand" size="sm" />
                <MetricTile label="Unsaved changes" value={dirtyCount} tone={dirtyCount > 0 ? "danger" : "neutral"} size="sm" />
              </SimpleGrid>

              <Paper withBorder radius="lg" p="md">
                <Stack gap="xs">
                  <Group justify="space-between" wrap="wrap" gap="sm">
                    <Stack gap={2}>
                      <Text fw={700} size="sm">
                        Per-scraper schedules
                      </Text>
                      <Text c="dimmed" size="xs">
                        Toggle automation and adjust cadence per source.
                      </Text>
                    </Stack>
                    <Text size="xs" c="dimmed">
                      {sources.length} scrapers
                    </Text>
                  </Group>
                  <Divider />

                  <Table.ScrollContainer minWidth={860}>
                    <Table withTableBorder withColumnBorders striped highlightOnHover verticalSpacing="sm">
                      <Table.Thead>
                        <Table.Tr>
                          <Table.Th>Scraper</Table.Th>
                          <Table.Th>Enabled</Table.Th>
                          <Table.Th>Interval</Table.Th>
                          <Table.Th>Last run</Table.Th>
                          <Table.Th>Next run</Table.Th>
                        </Table.Tr>
                      </Table.Thead>
                      <Table.Tbody>
                        {anyLoading ? (
                          <Table.Tr>
                            <Table.Td colSpan={5}>
                              <Group gap="sm">
                                <Loader size={18} />
                                <Text c="dimmed" size="sm">
                                  Loading schedules…
                                </Text>
                              </Group>
                            </Table.Td>
                          </Table.Tr>
                        ) : sources.length === 0 ? (
                          <Table.Tr>
                            <Table.Td colSpan={5}>
                              <Text c="dimmed" size="sm">
                                No sources yet.
                              </Text>
                            </Table.Td>
                          </Table.Tr>
                        ) : (
                          sources.map((source) => {
                            const current = currentBySlug.get(source.slug) ?? {
                              enabled: false,
                              intervalMinutes: DEFAULT_INTERVAL_MINUTES
                            };
                            const draft = draftBySlug[source.slug] ?? current;
                            const dirty = !scheduleEq(current, draft);
                            const last = lastBySlug.get(source.slug) ?? null;
                            const scheduleDoc: ScheduleDoc | undefined = schedulesBySlug.get(source.slug);
                            const nextRunAt = scheduleDoc?.nextRunAt ?? null;

                            return (
                              <Table.Tr key={source.slug} className={dirty ? classes.rowDirty : undefined}>
                                <Table.Td>
                                  <Stack gap={2}>
                                    <Group gap="sm" wrap="nowrap">
                                      <Text fw={700} size="sm" lineClamp={1} title={source.displayName} style={{ flex: 1 }}>
                                        {source.displayName}
                                      </Text>
                                      <Badge variant="light" color={source.enabled ? "teal" : "gray"} radius="xl">
                                        {source.enabled ? "enabled" : "disabled"}
                                      </Badge>
                                    </Group>
                                    <Text size="xs" c="dimmed">
                                      slug <span className={text.mono}>{source.slug}</span>
                                    </Text>
                                  </Stack>
                                </Table.Td>

                                <Table.Td>
                                  <Switch
                                    checked={draft.enabled}
                                    disabled={!source.enabled}
                                    onChange={(e) => {
                                      const enabled = e.currentTarget.checked;
                                      setDraftBySlug((prev) => ({
                                        ...prev,
                                        [source.slug]: { ...draft, enabled }
                                      }));
                                    }}
                                  />
                                </Table.Td>

                                <Table.Td>
                                  <NumberInput
                                    value={draft.intervalMinutes}
                                    min={1}
                                    max={10_080}
                                    clampBehavior="strict"
                                    allowDecimal={false}
                                    allowNegative={false}
                                    allowLeadingZeros={false}
                                    disabled={!source.enabled}
                                    onChange={(v) => {
                                      const n = typeof v === "number" ? v : Number.NaN;
                                      if (!Number.isFinite(n)) return;
                                      const intervalMinutes = Math.max(1, Math.min(10_080, Math.trunc(n)));
                                      setDraftBySlug((prev) => ({
                                        ...prev,
                                        [source.slug]: { ...draft, intervalMinutes }
                                      }));
                                    }}
                                  />
                                </Table.Td>

                                <Table.Td>
                                  {last?.lastRunAt ? (
                                    <Stack gap={2}>
                                      <Text size="sm" title={fmtTs(last.lastRunAt)}>
                                        {fmtAgo(last.lastRunAt)}
                                      </Text>
                                      {last.lastRunStatus ? (
                                        <Badge
                                          size="xs"
                                          variant="light"
                                          color={
                                            last.lastRunStatus === "failed"
                                              ? "red"
                                              : last.lastRunStatus === "completed"
                                                ? "teal"
                                                : last.lastRunStatus === "running"
                                                  ? "cyan"
                                                  : last.lastRunStatus === "pending"
                                                    ? "blue"
                                                    : "gray"
                                          }
                                          radius="xl"
                                        >
                                          {last.lastRunStatus}
                                        </Badge>
                                      ) : null}
                                    </Stack>
                                  ) : (
                                    <Text size="sm" c="dimmed">
                                      —
                                    </Text>
                                  )}
                                </Table.Td>

                                <Table.Td>
                                  {draft.enabled && nextRunAt ? (
                                    <Stack gap={2}>
                                      <Text size="sm" title={fmtTs(nextRunAt)}>
                                        {fmtAgo(nextRunAt)}
                                      </Text>
                                      {dirty ? (
                                        <Text size="xs" c="dimmed">
                                          updates after save
                                        </Text>
                                      ) : null}
                                    </Stack>
                                  ) : (
                                    <Text size="sm" c="dimmed">
                                      —
                                    </Text>
                                  )}
                                </Table.Td>
                              </Table.Tr>
                            );
                          })
                        )}
                      </Table.Tbody>
                    </Table>
                  </Table.ScrollContainer>
                </Stack>
              </Paper>

              <Paper withBorder radius="lg" p="md" className={classes.saveBar}>
                <Group justify="space-between" wrap="wrap" gap="sm">
                  <Text size="sm" c={dirtyCount > 0 ? undefined : "dimmed"}>
                    {dirtyCount} unsaved change{dirtyCount === 1 ? "" : "s"}
                  </Text>
                  <Button
                    leftSection={<IconDeviceFloppy size={16} />}
                    disabled={dirtyCount === 0 || saving}
                    loading={saving}
                    onClick={async () => {
                      if (dirtySlugs.length === 0) return;
                      setSaving(true);
                      try {
                        let saved = 0;
                        for (const slug of dirtySlugs) {
                          const draft = draftBySlug[slug];
                          if (!draft) continue;
                          await upsertSchedule({
                            sessionToken,
                            sourceSlug: slug,
                            enabled: draft.enabled,
                            intervalMinutes: draft.intervalMinutes
                          });
                          saved += 1;
                        }
                        notifications.show({
                          title: "Schedules saved",
                          message: `${saved} updated`
                        });
                      } catch (err) {
                        notifications.show({
                          title: "Save failed",
                          message: err instanceof Error ? err.message : String(err),
                          color: "red"
                        });
                      } finally {
                        setSaving(false);
                      }
                    }}
                  >
                    Save schedules
                  </Button>
                </Group>
              </Paper>
            </Stack>
          </Grid.Col>
        </Grid>
      </Stack>
    </Container>
  );
}
