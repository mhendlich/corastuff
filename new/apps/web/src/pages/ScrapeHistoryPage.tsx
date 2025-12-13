import { useQuery } from "convex/react";
import { useEffect, useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import {
  Anchor,
  Badge,
  Container,
  Group,
  Paper,
  Select,
  SimpleGrid,
  Stack,
  Table,
  Text,
  Tooltip
} from "@mantine/core";
import { MetricTile } from "../components/MetricTile";
import { fmtAgo, fmtTs } from "../lib/time";
import text from "../ui/text.module.css";
import { runsListRecent, sourcesList, type RunDoc, type SourceDoc } from "../convexFns";

type RunStatus = RunDoc["status"];

function asRunStatus(v: string | null): RunStatus | "all" {
  if (v === "pending" || v === "running" || v === "completed" || v === "failed" || v === "canceled") return v;
  return "all";
}

function asLimit(v: string | null) {
  const n = Number(v);
  if (!Number.isFinite(n)) return 100;
  const rounded = Math.round(n);
  if (rounded <= 25) return 25;
  if (rounded <= 50) return 50;
  if (rounded <= 100) return 100;
  return 200;
}

function fmtDuration(ms: number | null) {
  if (ms === null || !Number.isFinite(ms) || ms < 0) return "—";
  const totalSec = Math.floor(ms / 1000);
  const sec = totalSec % 60;
  const min = Math.floor(totalSec / 60) % 60;
  const hr = Math.floor(totalSec / 3600);
  if (hr > 0) return `${hr}h ${min}m`;
  if (min > 0) return `${min}m ${sec}s`;
  return `${sec}s`;
}

function statusTone(status: RunStatus) {
  if (status === "running") return { color: "cyan", label: "running" } as const;
  if (status === "pending") return { color: "blue", label: "queued" } as const;
  if (status === "failed") return { color: "red", label: "failed" } as const;
  if (status === "completed") return { color: "teal", label: "completed" } as const;
  return { color: "gray", label: "canceled" } as const;
}

export function ScrapeHistoryPage(props: { sessionToken: string }) {
  const { sessionToken } = props;
  const sources: SourceDoc[] = useQuery(sourcesList, { sessionToken }) ?? [];
  const [searchParams, setSearchParams] = useSearchParams();

  const [scraper, setScraper] = useState<string>(() => searchParams.get("scraper") ?? "all");
  const [status, setStatus] = useState<RunStatus | "all">(() => asRunStatus(searchParams.get("status")));
  const [limit, setLimit] = useState<number>(() => asLimit(searchParams.get("limit")));

  useEffect(() => {
    const nextScraper = searchParams.get("scraper") ?? "all";
    const nextStatus = asRunStatus(searchParams.get("status"));
    const nextLimit = asLimit(searchParams.get("limit"));
    setScraper(nextScraper);
    setStatus(nextStatus);
    setLimit(nextLimit);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchParams.toString()]);

  const scanLimit = useMemo(() => Math.min(Math.max(limit * 3, limit), 200), [limit]);
  const runs: RunDoc[] = useQuery(runsListRecent, {
    sessionToken,
    limit: scanLimit,
    sourceSlug: scraper !== "all" ? scraper : undefined
  }) ?? [];

  const filtered = useMemo(() => {
    const byStatus = status === "all" ? runs : runs.filter((r) => r.status === status);
    return byStatus.slice(0, limit);
  }, [runs, status, limit]);

  const kpis = useMemo(() => {
    const out = { total: filtered.length, completed: 0, failed: 0, running: 0, pending: 0, canceled: 0 };
    for (const r of filtered) out[r.status] += 1;
    const terminal = out.completed + out.failed + out.canceled;
    const successRate = terminal > 0 ? Math.round((out.completed / terminal) * 100) : null;
    return { ...out, terminal, successRate };
  }, [filtered]);

  const recentFailures = useMemo(() => filtered.filter((r) => r.status === "failed").slice(0, 5), [filtered]);

  const sourceOptions = useMemo(() => {
    const base = [{ value: "all", label: "All scrapers" }];
    const items = [...sources]
      .sort((a, b) => a.slug.localeCompare(b.slug))
      .map((s) => ({ value: s.slug, label: `${s.displayName} (${s.slug})` }));
    return [...base, ...items];
  }, [sources]);

  return (
    <Container size="xl" py="xl">
      <Stack gap="lg">
        <Group justify="space-between" wrap="wrap" gap="md">
          <Stack gap={4}>
            <Text fw={750}>Scrape History</Text>
            <Text c="dimmed" size="sm">
              Review recent runs, filter failures, and drill into artifacts.
            </Text>
          </Stack>

          <Group gap="md" wrap="wrap">
            <Select
              label="Scraper"
              value={scraper}
              data={sourceOptions}
              searchable
              w={380}
              onChange={(v) => {
                const next = v ?? "all";
                setSearchParams((prev) => {
                  const p = new URLSearchParams(prev);
                  if (next === "all") p.delete("scraper");
                  else p.set("scraper", next);
                  return p;
                });
              }}
            />
            <Select
              label="Status"
              value={status}
              data={[
                { value: "all", label: "All statuses" },
                { value: "running", label: "Running" },
                { value: "pending", label: "Queued" },
                { value: "failed", label: "Failed" },
                { value: "completed", label: "Completed" },
                { value: "canceled", label: "Canceled" }
              ]}
              w={180}
              onChange={(v) => {
                const next = asRunStatus(v);
                setSearchParams((prev) => {
                  const p = new URLSearchParams(prev);
                  if (next === "all") p.delete("status");
                  else p.set("status", next);
                  return p;
                });
              }}
            />
            <Select
              label="Limit"
              value={String(limit)}
              data={[
                { value: "25", label: "25" },
                { value: "50", label: "50" },
                { value: "100", label: "100" },
                { value: "200", label: "200" }
              ]}
              w={120}
              onChange={(v) => {
                const next = asLimit(v);
                setSearchParams((prev) => {
                  const p = new URLSearchParams(prev);
                  if (next === 100) p.delete("limit");
                  else p.set("limit", String(next));
                  return p;
                });
              }}
            />
          </Group>
        </Group>

        <SimpleGrid cols={{ base: 1, sm: 2, md: 3, lg: 5 }} spacing="md">
          <MetricTile label="Total" value={kpis.total} size="sm" />
          <MetricTile label="Completed" value={kpis.completed} size="sm" tone="brand" />
          <MetricTile label="Failed" value={kpis.failed} size="sm" tone="danger" />
          <MetricTile label="Running" value={kpis.running + kpis.pending} size="sm" />
          <MetricTile
            label="Success rate"
            value={kpis.successRate === null ? "—" : `${kpis.successRate}%`}
            hint="(completed / terminal)"
            size="sm"
          />
        </SimpleGrid>

        {recentFailures.length > 0 ? (
          <Paper withBorder radius="lg" p="md">
            <Group justify="space-between" wrap="wrap" gap="md">
              <Text fw={700}>Recent failures</Text>
              <Text size="sm" c="dimmed">
                Showing {recentFailures.length} of {kpis.failed}
              </Text>
            </Group>
            <Stack gap={6} mt="sm">
              {recentFailures.map((r) => (
                <Group key={r._id} justify="space-between" wrap="nowrap" gap="md">
                  <Group gap="sm" wrap="nowrap" style={{ minWidth: 0 }}>
                    <Badge variant="light" color="red" radius="xl">
                      failed
                    </Badge>
                    <Text size="sm" lineClamp={1} style={{ flex: 1 }}>
                      <span className={text.mono}>{r.sourceSlug}</span> • {fmtAgo(r.completedAt ?? r.startedAt ?? r._creationTime)}
                    </Text>
                  </Group>
                  <Anchor component={Link} to={`/scrapers/history/${r._id}`} size="sm">
                    open
                  </Anchor>
                </Group>
              ))}
            </Stack>
          </Paper>
        ) : null}

        <Table.ScrollContainer minWidth={1080}>
          <Table withTableBorder withColumnBorders striped highlightOnHover verticalSpacing="sm">
            <Table.Thead>
              <Table.Tr>
                <Table.Th>Scraper</Table.Th>
                <Table.Th>Status</Table.Th>
                <Table.Th>Started</Table.Th>
                <Table.Th>Duration</Table.Th>
                <Table.Th>Products</Table.Th>
                <Table.Th>Error</Table.Th>
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {filtered.length === 0 ? (
                <Table.Tr>
                  <Table.Td colSpan={6}>
                    <Text c="dimmed" size="sm">
                      No runs yet.
                    </Text>
                  </Table.Td>
                </Table.Tr>
              ) : (
                filtered.map((r) => {
                  const startedAt = r.startedAt ?? r._creationTime ?? null;
                  const endedAt =
                    typeof r.completedAt === "number"
                      ? r.completedAt
                      : r.status === "running"
                        ? Date.now()
                        : null;
                  const duration = endedAt && startedAt ? fmtDuration(endedAt - startedAt) : "—";
                  const startedLabel = startedAt ? fmtTs(startedAt) : "—";
                  const tone = statusTone(r.status);
                  const error = typeof r.error === "string" ? r.error.trim() : "";
                  const errorShort = error.length > 140 ? `${error.slice(0, 140)}…` : error || "—";

                  return (
                    <Table.Tr key={r._id}>
                      <Table.Td>
                        <Anchor component={Link} to={`/scrapers/history/${r._id}`} size="sm">
                          <span className={text.mono}>{r.sourceSlug}</span>
                        </Anchor>
                      </Table.Td>
                      <Table.Td>
                        <Badge variant="light" color={tone.color} radius="xl">
                          {tone.label}
                        </Badge>
                      </Table.Td>
                      <Table.Td>
                        <Text size="sm">{startedLabel}</Text>
                      </Table.Td>
                      <Table.Td>
                        <Text size="sm" className={text.mono}>
                          {duration}
                        </Text>
                      </Table.Td>
                      <Table.Td>
                        <Text size="sm" className={text.mono}>
                          {typeof r.productsFound === "number" ? r.productsFound : "—"}
                        </Text>
                      </Table.Td>
                      <Table.Td>
                        {error === "" ? (
                          <Text size="sm" c="dimmed">
                            —
                          </Text>
                        ) : (
                          <Tooltip label={error} withArrow multiline w={480}>
                            <Text size="sm" lineClamp={2}>
                              {errorShort}
                            </Text>
                          </Tooltip>
                        )}
                      </Table.Td>
                    </Table.Tr>
                  );
                })
              )}
            </Table.Tbody>
          </Table>
        </Table.ScrollContainer>

        <Text size="xs" c="dimmed">
          Showing up to <span className={text.mono}>{limit}</span> runs (scanned{" "}
          <span className={text.mono}>{scanLimit}</span>).
        </Text>
      </Stack>
    </Container>
  );
}
