import { useAction, useQuery } from "convex/react";
import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import {
  ActionIcon,
  Anchor,
  Badge,
  Button,
  Chip,
  Container,
  Group,
  Loader,
  SimpleGrid,
  Stack,
  Table,
  Text,
  TextInput,
  Tooltip
} from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { IconCircleX, IconExternalLink, IconPlayerPlay, IconRefresh, IconSearch } from "@tabler/icons-react";
import { MetricTile } from "../components/MetricTile";
import { fmtAgo, fmtTs } from "../lib/time";
import text from "../ui/text.module.css";
import {
  dashboardLastScrapes,
  linksCountsBySource,
  runsCancel,
  runsListActive,
  runsRequest,
  runsRequestAll,
  sourcesList,
  type LinkCountsBySource,
  type SourceLastScrape
} from "../convexFns";
import classes from "./ScrapersPage.module.css";

type ScraperStatus = "running" | "queued" | "failed" | "completed" | "idle";

function statusTone(status: ScraperStatus) {
  switch (status) {
    case "running":
      return { color: "cyan", label: "Running" } as const;
    case "queued":
      return { color: "blue", label: "Queued" } as const;
    case "failed":
      return { color: "red", label: "Failed" } as const;
    case "completed":
      return { color: "teal", label: "Completed" } as const;
    default:
      return { color: "gray", label: "Idle" } as const;
  }
}

function normalize(s: string) {
  return s.toLowerCase().trim();
}

export function ScrapersPage(props: { sessionToken: string }) {
  const { sessionToken } = props;
  const sources = useQuery(sourcesList, { sessionToken }) ?? [];
  const lastScrapes: SourceLastScrape[] = useQuery(dashboardLastScrapes, { sessionToken }) ?? [];
  const activeRuns = useQuery(runsListActive, { sessionToken }) ?? [];

  const skip = "skip" as const;
  const counts: LinkCountsBySource[] =
    useQuery(linksCountsBySource, sources.length > 0 ? { sessionToken, sourceSlugs: sources.map((s) => s.slug) } : skip) ??
    [];

  const requestRun = useAction(runsRequest);
  const requestAll = useAction(runsRequestAll);
  const cancelRun = useAction(runsCancel);

  const [q, setQ] = useState("");
  const [statusFilter, setStatusFilter] = useState<"all" | ScraperStatus>("all");
  const [runningActionForSlug, setRunningActionForSlug] = useState<string | null>(null);

  const activeRunBySourceSlug = useMemo(() => {
    const map = new Map<string, (typeof activeRuns)[number]>();
    for (const run of activeRuns) {
      if (!map.has(run.sourceSlug)) map.set(run.sourceSlug, run);
    }
    return map;
  }, [activeRuns]);

  const lastBySourceSlug = useMemo(() => new Map(lastScrapes.map((s) => [s.sourceSlug, s])), [lastScrapes]);
  const countsBySourceSlug = useMemo(() => new Map(counts.map((c) => [c.sourceSlug, c])), [counts]);

  const rows = useMemo(() => {
    return sources
      .map((source) => {
        const active = activeRunBySourceSlug.get(source.slug) ?? null;
        const last = lastBySourceSlug.get(source.slug) ?? null;
        const c = countsBySourceSlug.get(source.slug) ?? null;

        let status: ScraperStatus = "idle";
        let runId: string | null = null;
        let runStatus: string | null = null;
        let lastActivityAt: number | null = null;
        let cancelRequested = false;

        if (active) {
          status = active.status === "pending" ? "queued" : "running";
          runId = active._id;
          runStatus = active.status;
          lastActivityAt = active.startedAt ?? active._creationTime ?? null;
          cancelRequested = active.cancelRequested === true;
        } else if (last?.lastRunStatus) {
          if (last.lastRunStatus === "failed") status = "failed";
          else if (last.lastRunStatus === "completed") status = "completed";
          else status = "idle";
          runId = last.lastRunId;
          runStatus = last.lastRunStatus;
          lastActivityAt = last.lastRunAt;
        }

        return {
          source,
          status,
          runId,
          runStatus,
          lastActivityAt,
          cancelRequested,
          counts: c,
          active
        };
      })
      .sort((a, b) => {
        const rank = (s: ScraperStatus) => (s === "running" ? 0 : s === "queued" ? 1 : s === "failed" ? 2 : s === "idle" ? 3 : 4);
        const ra = rank(a.status);
        const rb = rank(b.status);
        if (ra !== rb) return ra - rb;
        return a.source.slug.localeCompare(b.source.slug);
      });
  }, [sources, activeRunBySourceSlug, lastBySourceSlug, countsBySourceSlug]);

  const countsByStatus = useMemo(() => {
    const out: Record<ScraperStatus, number> = { running: 0, queued: 0, failed: 0, completed: 0, idle: 0 };
    for (const r of rows) out[r.status] += 1;
    return out;
  }, [rows]);

  const filteredRows = useMemo(() => {
    const query = normalize(q);
    return rows.filter((r) => {
      if (statusFilter !== "all" && r.status !== statusFilter) return false;
      if (!query) return true;
      const hay = `${r.source.slug} ${r.source.displayName}`.toLowerCase();
      return hay.includes(query);
    });
  }, [rows, q, statusFilter]);

  return (
    <Container size="xl" py="xl">
      <Stack gap="lg">
        <Group justify="space-between" align="flex-end" wrap="wrap" gap="md">
          <Stack gap={4}>
            <Text fw={750}>Scrapers</Text>
            <Text c="dimmed" size="sm">
              Monitor sources, queue runs, and inspect failures.
            </Text>
          </Stack>

          <Group gap="sm" wrap="wrap">
            <Button
              variant="light"
              leftSection={<IconRefresh size={16} />}
              onClick={async () => {
                try {
                  const result = await requestAll({ sessionToken });
                  const requested = result.results.filter((r) => r.ok && typeof r.runId === "string").length;
                  const skipped = result.results.filter((r) => typeof r.skipped === "string").length;
                  const failed = result.results.filter((r) => !r.ok && typeof r.error === "string").length;
                  notifications.show({
                    title: "Run all requested",
                    message: `${requested} queued • ${skipped} skipped${failed > 0 ? ` • ${failed} failed` : ""}`
                  });
                } catch (err) {
                  notifications.show({
                    title: "Run all failed",
                    message: err instanceof Error ? err.message : String(err),
                    color: "red"
                  });
                }
              }}
            >
              Run all enabled
            </Button>
            <Button component={Link} to="/scrapers/history" variant="default">
              View history
            </Button>
          </Group>
        </Group>

        <SimpleGrid cols={{ base: 1, sm: 2, md: 3, lg: 6 }} spacing="md">
          <MetricTile label="Running" value={countsByStatus.running} tone="brand" size="sm" />
          <MetricTile label="Queued" value={countsByStatus.queued} tone="neutral" size="sm" />
          <MetricTile label="Failed" value={countsByStatus.failed} tone="danger" size="sm" />
          <MetricTile label="Completed" value={countsByStatus.completed} tone="neutral" size="sm" />
          <MetricTile label="Idle" value={countsByStatus.idle} tone="neutral" size="sm" />
          <MetricTile label="Total" value={rows.length} tone="neutral" size="sm" />
        </SimpleGrid>

        <Group justify="space-between" wrap="wrap" gap="md">
          <TextInput
            value={q}
            onChange={(e) => setQ(e.currentTarget.value)}
            placeholder="Search sources…"
            leftSection={<IconSearch size={16} />}
            w={360}
          />

          <Chip.Group
            multiple={false}
            value={statusFilter}
            onChange={(v) => {
              if (v === "all" || v === "running" || v === "queued" || v === "failed" || v === "completed" || v === "idle") {
                setStatusFilter(v);
              }
            }}
          >
            <Group gap="xs" wrap="wrap">
              <Chip value="all">All ({rows.length})</Chip>
              <Chip value="running">Running ({countsByStatus.running})</Chip>
              <Chip value="queued">Queued ({countsByStatus.queued})</Chip>
              <Chip value="failed">Failed ({countsByStatus.failed})</Chip>
              <Chip value="completed">Completed ({countsByStatus.completed})</Chip>
              <Chip value="idle">Idle ({countsByStatus.idle})</Chip>
            </Group>
          </Chip.Group>
        </Group>

        <Table.ScrollContainer minWidth={980}>
          <Table withTableBorder withColumnBorders striped highlightOnHover verticalSpacing="sm">
            <Table.Thead>
              <Table.Tr>
                <Table.Th>Source</Table.Th>
                <Table.Th>Status</Table.Th>
                <Table.Th>Last activity</Table.Th>
                <Table.Th>Products</Table.Th>
                <Table.Th>Actions</Table.Th>
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {filteredRows.length === 0 ? (
                <Table.Tr>
                  <Table.Td colSpan={5}>
                    <Text c="dimmed" size="sm">
                      No matching sources.
                    </Text>
                  </Table.Td>
                </Table.Tr>
              ) : (
                filteredRows.map((r) => {
                  const tone = statusTone(r.status);
                  const lastActivityLabel = r.lastActivityAt ? fmtAgo(r.lastActivityAt) : "—";
                  const lastActivityTitle = r.lastActivityAt ? fmtTs(r.lastActivityAt) : undefined;
                  const runHref = r.runId ? `/scrapers/history/${r.runId}` : null;
                  const products = r.counts;
                  const total = products ? products.totalProducts : null;
                  const linked = products ? products.linked : null;
                  const unlinked = products ? products.unlinked : null;
                  const missingItemIds = products ? products.missingItemIds : null;

                  const rowClass =
                    r.active || r.status === "running" || r.status === "queued"
                      ? classes.rowActive
                      : !r.source.enabled
                        ? classes.rowDisabled
                        : undefined;

                  const actionBusy = runningActionForSlug === r.source.slug;
                  const canCancel = !!r.active && (r.active.status === "pending" || r.active.status === "running");
                  const canRun = r.source.enabled === true && !actionBusy && !canCancel;

                  return (
                    <Table.Tr key={r.source.slug} className={rowClass}>
                      <Table.Td>
                        <Stack gap={2}>
                          <Group gap="sm" wrap="nowrap">
                            <Text fw={700} size="sm" lineClamp={1} title={r.source.displayName} style={{ flex: 1 }}>
                              {r.source.displayName}
                            </Text>
                            <Badge variant="light" color={r.source.enabled ? "teal" : "gray"} radius="xl">
                              {r.source.enabled ? "enabled" : "disabled"}
                            </Badge>
                            <Badge variant="light" color="gray" radius="xl">
                              {r.source.type}
                            </Badge>
                          </Group>
                          <Text size="xs" c="dimmed">
                            slug <span className={text.mono}>{r.source.slug}</span>
                          </Text>
                        </Stack>
                      </Table.Td>
                      <Table.Td>
                        <Stack gap={4}>
                          <Badge variant="light" color={tone.color} radius="xl">
                            {tone.label}
                          </Badge>
                          {r.cancelRequested ? (
                            <Badge variant="light" color="yellow" radius="xl">
                              cancel requested
                            </Badge>
                          ) : null}
                          {r.runStatus ? (
                            <Text size="xs" c="dimmed">
                              run status <span className={text.mono}>{r.runStatus}</span>
                            </Text>
                          ) : null}
                        </Stack>
                      </Table.Td>
                      <Table.Td>
                        <Text size="sm" title={lastActivityTitle}>
                          {lastActivityLabel}
                        </Text>
                      </Table.Td>
                      <Table.Td>
                        {products ? (
                          <Stack gap={2}>
                            <Text fw={700} size="sm" className={text.mono}>
                              {total}
                            </Text>
                            <Group gap="md" wrap="wrap">
                              <Text size="xs" c="dimmed">
                                linked <span className={text.mono}>{linked}</span>
                              </Text>
                              <Text size="xs" c="dimmed">
                                unlinked <span className={text.mono}>{unlinked}</span>
                              </Text>
                              {typeof missingItemIds === "number" && missingItemIds > 0 ? (
                                <Text size="xs" c="yellow.2">
                                  missing IDs <span className={text.mono}>{missingItemIds}</span>
                                </Text>
                              ) : null}
                            </Group>
                          </Stack>
                        ) : (
                          <Text size="sm" c="dimmed">
                            —
                          </Text>
                        )}
                      </Table.Td>
                      <Table.Td>
                        <Group gap="xs" wrap="nowrap">
                          <Tooltip label={canCancel ? "Cancel run" : "Run now"} withArrow>
                            <ActionIcon
                              variant="default"
                              size="lg"
                              disabled={!canRun && !canCancel}
                              onClick={async () => {
                                setRunningActionForSlug(r.source.slug);
                                try {
                                  if (canCancel && r.active) {
                                    await cancelRun({ sessionToken, runId: r.active._id });
                                    notifications.show({ title: "Cancel requested", message: r.source.slug });
                                  } else {
                                    await requestRun({ sessionToken, sourceSlug: r.source.slug });
                                    notifications.show({ title: "Queued run", message: r.source.slug });
                                  }
                                } catch (err) {
                                  notifications.show({
                                    title: "Action failed",
                                    message: err instanceof Error ? err.message : String(err),
                                    color: "red"
                                  });
                                } finally {
                                  setRunningActionForSlug(null);
                                }
                              }}
                            >
                              {actionBusy ? (
                                <Loader size={18} />
                              ) : canCancel ? (
                                <IconCircleX size={18} />
                              ) : (
                                <IconPlayerPlay size={18} />
                              )}
                            </ActionIcon>
                          </Tooltip>

                          <Tooltip label="Open history (filtered)" withArrow>
                            <ActionIcon
                              component={Link}
                              to={`/scrapers/history?scraper=${encodeURIComponent(r.source.slug)}`}
                              variant="default"
                              size="lg"
                            >
                              <IconSearch size={18} />
                            </ActionIcon>
                          </Tooltip>

                          {runHref ? (
                            <Tooltip label="Open latest run detail" withArrow>
                              <ActionIcon component={Link} to={runHref} variant="default" size="lg">
                                <IconExternalLink size={18} />
                              </ActionIcon>
                            </Tooltip>
                          ) : (
                            <Anchor
                              component="span"
                              size="sm"
                              c="dimmed"
                              style={{ display: "inline-flex", alignItems: "center", gap: 6 }}
                            >
                              <IconExternalLink size={16} />
                              no runs
                            </Anchor>
                          )}
                        </Group>
                      </Table.Td>
                    </Table.Tr>
                  );
                })
              )}
            </Table.Tbody>
          </Table>
        </Table.ScrollContainer>
      </Stack>
    </Container>
  );
}
