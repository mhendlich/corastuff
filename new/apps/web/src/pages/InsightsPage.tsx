import { useQuery } from "convex/react";
import { Badge, Card, Container, Group, SimpleGrid, Stack, Text, Title } from "@mantine/core";
import { MetricTile } from "../components/MetricTile";
import { Panel } from "../components/Panel";
import { MoverRow } from "../features/insights/components/MoverRow";
import { insightsSnapshot, type InsightsSnapshot } from "../convexFns";
import { fmtAgo, fmtTs } from "../lib/time";
import text from "../ui/text.module.css";
import classes from "./InsightsPage.module.css";

export function InsightsPage(props: { sessionToken: string }) {
  const snapshot: InsightsSnapshot | undefined = useQuery(insightsSnapshot, { sessionToken: props.sessionToken });

  if (snapshot === undefined) {
    return (
      <Container size="xl" py="xl">
        <Text c="dimmed">Loading insights…</Text>
      </Container>
    );
  }

  return (
    <Container size="xl" py="xl">
      <Stack gap="lg">
        <Group justify="space-between">
          <Text size="xs" c="dimmed">
            Generated {fmtTs(snapshot.generatedAt)}
          </Text>
        </Group>

        <SimpleGrid cols={{ base: 2, md: 3, lg: 6 }} spacing="md">
          <MetricTile
            label="Recent Drops"
            value={String(snapshot.summary.recentDrops)}
            hint="Big reductions vs previous scrape."
            tone="brand"
          />
          <MetricTile
            label="Recent Spikes"
            value={String(snapshot.summary.recentSpikes)}
            hint="Large upticks needing validation."
            tone="warn"
          />
          <MetricTile label="New Extremes" value="—" hint="Coming soon." />
          <MetricTile label="Outliers" value="—" hint="Coming soon." />
          <MetricTile
            label="Stale Sources"
            value={String(snapshot.summary.staleSources)}
            hint="Older than 12h since last success."
          />
          <MetricTile
            label="Recent Failures"
            value={String(snapshot.summary.recentFailures)}
            hint="Failed runs in last 36h."
            tone="danger"
          />
        </SimpleGrid>

        <SimpleGrid cols={{ base: 1, lg: 3 }} spacing="md">
          <Panel style={{ gridColumn: "span 2" }}>
            <Group justify="space-between" align="flex-end">
              <div>
                <Title order={4}>Last-Run Movers</Title>
                <Text size="sm" c="dimmed">
                  Biggest swings since the previous scrape
                </Text>
              </div>
              <Text size="xs" c="dimmed">
                Needs 2+ price points
              </Text>
            </Group>

            <SimpleGrid cols={{ base: 1, md: 2 }} spacing="md" mt="lg">
              <Stack gap="sm">
                <Group justify="space-between">
                  <Text size="xs" tt="uppercase" fw={700} c="teal.2" className={text.tracking}>
                    Drops
                  </Text>
                  <Badge variant="light" color="gray">
                    {snapshot.movers.drops.length}
                  </Badge>
                </Group>
                {snapshot.movers.drops.length > 0 ? (
                  <Stack gap="sm">
                    {snapshot.movers.drops.map((m) => (
                      <MoverRow key={`${m.sourceSlug}:${m.itemId}`} kind="drop" mover={m} />
                    ))}
                  </Stack>
                ) : (
                  <Text c="dimmed" size="sm">
                    No drops detected yet.
                  </Text>
                )}
              </Stack>

              <Stack gap="sm">
                <Group justify="space-between">
                  <Text size="xs" tt="uppercase" fw={700} c="yellow.2" className={text.tracking}>
                    Spikes
                  </Text>
                  <Badge variant="light" color="gray">
                    {snapshot.movers.spikes.length}
                  </Badge>
                </Group>
                {snapshot.movers.spikes.length > 0 ? (
                  <Stack gap="sm">
                    {snapshot.movers.spikes.map((m) => (
                      <MoverRow key={`${m.sourceSlug}:${m.itemId}`} kind="spike" mover={m} />
                    ))}
                  </Stack>
                ) : (
                  <Text c="dimmed" size="sm">
                    No spikes detected yet.
                  </Text>
                )}
              </Stack>
            </SimpleGrid>
          </Panel>

          <Stack gap="md">
            <Panel>
              <Group justify="space-between">
                <Title order={5}>Stale sources</Title>
                <Badge variant="light" color="gray">
                  {snapshot.staleSources.length}
                </Badge>
              </Group>
              <Stack gap="xs" mt="md">
                {snapshot.staleSources.length > 0 ? (
                  snapshot.staleSources.slice(0, 10).map((s) => (
                    <Group key={s.sourceSlug} justify="space-between" wrap="nowrap" gap="md">
                      <Text size="sm" lineClamp={1}>
                        {s.displayName}
                      </Text>
                      <Text size="xs" c="dimmed">
                        {s.lastSuccessfulAt ? fmtAgo(s.lastSuccessfulAt) : "never"}
                      </Text>
                    </Group>
                  ))
                ) : (
                  <Text c="dimmed" size="sm">
                    All sources look fresh.
                  </Text>
                )}
              </Stack>
            </Panel>

            <Panel>
              <Group justify="space-between">
                <Title order={5}>Recent failures</Title>
                <Badge variant="light" color="gray">
                  {snapshot.recentFailures.length}
                </Badge>
              </Group>
              <Stack gap="sm" mt="md">
                {snapshot.recentFailures.length > 0 ? (
                  snapshot.recentFailures.map((f) => (
                    <Card key={f.runId} withBorder radius="md" p="md" className={classes.failureCard}>
                      <Group justify="space-between" align="flex-start" wrap="nowrap" gap="md">
                        <Text size="sm" fw={600} lineClamp={1}>
                          {f.sourceSlug}
                        </Text>
                        <Text size="xs" c="dimmed">
                          {fmtTs(f.startedAt)}
                        </Text>
                      </Group>
                      {f.error ? (
                        <Text size="xs" mt={6} className={classes.failureText}>
                          {f.error}
                        </Text>
                      ) : (
                        <Text size="xs" c="dimmed" mt={6}>
                          No error message.
                        </Text>
                      )}
                    </Card>
                  ))
                ) : (
                  <Text c="dimmed" size="sm">
                    No recent failures.
                  </Text>
                )}
              </Stack>
            </Panel>
          </Stack>
        </SimpleGrid>
      </Stack>
    </Container>
  );
}

