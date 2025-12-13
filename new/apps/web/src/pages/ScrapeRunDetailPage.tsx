import { useQuery } from "convex/react";
import { useMemo } from "react";
import { Link, useParams, useSearchParams } from "react-router-dom";
import { CodeHighlight } from "@mantine/code-highlight";
import { Anchor, Badge, Container, Divider, Group, Paper, ScrollArea, SimpleGrid, Stack, Text, Title } from "@mantine/core";
import { IconBraces, IconFileText, IconPhoto } from "@tabler/icons-react";
import { MetricTile } from "../components/MetricTile";
import { eventSummary } from "../features/dashboard/utils";
import { fmtTs } from "../lib/time";
import text from "../ui/text.module.css";
import { runArtifactsListForRun, runsGet, runsListEvents, type RunArtifactDoc } from "../convexFns";

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

function statusTone(status: string) {
  if (status === "running") return { color: "cyan", label: "running" } as const;
  if (status === "pending") return { color: "blue", label: "queued" } as const;
  if (status === "failed") return { color: "red", label: "failed" } as const;
  if (status === "completed") return { color: "teal", label: "completed" } as const;
  if (status === "canceled") return { color: "gray", label: "canceled" } as const;
  return { color: "gray", label: status } as const;
}

function artifactIcon(a: RunArtifactDoc) {
  if (a.type === "screenshot" || /\.(png|jpe?g|webp|gif)$/i.test(a.path)) return <IconPhoto size={14} />;
  if (a.type === "json" || a.key.endsWith(".json")) return <IconBraces size={14} />;
  return <IconFileText size={14} />;
}

export function ScrapeRunDetailPage(props: { sessionToken: string }) {
  const { sessionToken } = props;
  const params = useParams();
  const runId = params.runId ?? "";
  const [searchParams] = useSearchParams();
  const backScraper = searchParams.get("scraper");

  const skip = "skip" as const;
  const run = useQuery(runsGet, runId ? { sessionToken, runId } : skip) ?? null;
  const events = useQuery(runsListEvents, runId ? { sessionToken, runId, limit: 200 } : skip) ?? [];
  const artifacts = useQuery(runArtifactsListForRun, runId ? { sessionToken, runId } : skip) ?? [];

  const orderedEvents = useMemo(() => [...events].reverse(), [events]);
  const startedAt = run?.startedAt ?? run?._creationTime ?? null;
  const completedAt = run?.completedAt ?? null;
  const durationMs = startedAt && completedAt ? completedAt - startedAt : run?.status === "running" && startedAt ? Date.now() - startedAt : null;

  const tone = statusTone(run?.status ?? "unknown");
  const sourceSlug = run?.sourceSlug ?? null;

  const backHref = backScraper ? `/scrapers/history?scraper=${encodeURIComponent(backScraper)}` : sourceSlug ? `/scrapers/history?scraper=${encodeURIComponent(sourceSlug)}` : "/scrapers/history";

  return (
    <Container size="xl" py="xl">
      <Stack gap="lg">
        <Group justify="space-between" wrap="wrap" gap="md">
          <Stack gap={4}>
            <Title order={3}>Run detail</Title>
            <Group gap="sm" wrap="wrap">
              <Badge variant="light" color={tone.color} radius="xl">
                {tone.label}
              </Badge>
              {sourceSlug ? (
                <Text size="sm">
                  scraper <span className={text.mono}>{sourceSlug}</span>
                </Text>
              ) : null}
              {run?._id ? (
                <Text size="sm" c="dimmed">
                  id <span className={text.mono}>{run._id}</span>
                </Text>
              ) : null}
            </Group>
          </Stack>

          <Group gap="sm" wrap="wrap">
            <Anchor component={Link} to={backHref} size="sm">
              Back to history
            </Anchor>
            <Anchor component={Link} to="/scrapers" size="sm">
              Scrapers
            </Anchor>
          </Group>
        </Group>

        {!runId ? (
          <Paper withBorder radius="lg" p="xl">
            <Text c="red.2">Missing run id.</Text>
          </Paper>
        ) : run === null ? (
          <Paper withBorder radius="lg" p="xl">
            <Text c="red.2">Run not found.</Text>
          </Paper>
        ) : (
          <>
            <SimpleGrid cols={{ base: 1, sm: 2, md: 4 }} spacing="md">
              <MetricTile label="Started" value={fmtTs(startedAt ?? undefined)} size="sm" />
              <MetricTile label="Completed" value={fmtTs(completedAt ?? undefined)} size="sm" />
              <MetricTile label="Duration" value={fmtDuration(durationMs)} size="sm" />
              <MetricTile
                label="Products"
                value={typeof run.productsFound === "number" ? run.productsFound : "—"}
                size="sm"
              />
            </SimpleGrid>

            {run.cancelRequested ? (
              <Paper withBorder radius="lg" p="md">
                <Badge variant="light" color="yellow" radius="xl">
                  cancel requested
                </Badge>
              </Paper>
            ) : null}

            {typeof run.error === "string" && run.error.trim() ? (
              <Paper withBorder radius="lg" p="md">
                <Text fw={700} mb="xs">
                  Error
                </Text>
                <CodeHighlight language="txt" code={run.error} />
              </Paper>
            ) : null}

            <Paper withBorder radius="lg" p="md">
              <Group justify="space-between" wrap="wrap" gap="md">
                <Text fw={700}>Artifacts</Text>
                <Text size="sm" c="dimmed">
                  {artifacts.length}
                </Text>
              </Group>
              <Divider my="sm" />
              {artifacts.length === 0 ? (
                <Text size="sm" c="dimmed">
                  No artifacts.
                </Text>
              ) : (
                <Group gap="sm" wrap="wrap">
                  {artifacts.map((a) => (
                    <Anchor key={a._id} href={`/media/${a.path}`} target="_blank" rel="noreferrer" size="sm">
                      <Group gap={6} wrap="nowrap">
                        {artifactIcon(a)}
                        <Text component="span" inherit className={text.mono}>
                          {a.key}
                        </Text>
                      </Group>
                    </Anchor>
                  ))}
                </Group>
              )}
            </Paper>

            <Paper withBorder radius="lg" p="md">
              <Group justify="space-between" wrap="wrap" gap="md">
                <Text fw={700}>Events</Text>
                <Text size="sm" c="dimmed">
                  {orderedEvents.length}
                </Text>
              </Group>
              <Divider my="sm" />
              {orderedEvents.length === 0 ? (
                <Text size="sm" c="dimmed">
                  No events yet.
                </Text>
              ) : (
                <ScrollArea h={420} type="auto" scrollbarSize={8}>
                  <Stack gap={6} pr="sm">
                    {orderedEvents.map((e) => (
                      <Text key={e._id} size="sm" className={text.mono}>
                        {eventSummary(e)}
                      </Text>
                    ))}
                  </Stack>
                </ScrollArea>
              )}
            </Paper>
          </>
        )}
      </Stack>
    </Container>
  );
}
