import { useQuery } from "convex/react";
import { Anchor, Badge, Card, Container, Group, SimpleGrid, Stack, Table, Text, Title } from "@mantine/core";
import { DonutChart } from "@mantine/charts";
import { Link } from "react-router-dom";
import { MetricTile } from "../components/MetricTile";
import { Panel } from "../components/Panel";
import { MoverRow } from "../features/insights/components/MoverRow";
import { ExtremeRow } from "../features/insights/components/ExtremeRow";
import { OutlierRow } from "../features/insights/components/OutlierRow";
import { StreakRow } from "../features/insights/components/StreakRow";
import { CanonicalGapRow } from "../features/insights/components/CanonicalGapRow";
import { insightsSnapshot, type InsightsSnapshot } from "../convexFns";
import { fmtAgo, fmtTs } from "../lib/time";
import { linkWorkbenchHref } from "../lib/routes";
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

  const donutData = [
    { name: "Drops", value: snapshot.summary.recentDrops, color: "teal" },
    { name: "Spikes", value: snapshot.summary.recentSpikes, color: "yellow" },
    { name: "New extremes", value: snapshot.summary.newExtremes, color: "violet" },
    { name: "Outliers", value: snapshot.summary.outliers, color: "cyan" },
    { name: "Stale sources", value: snapshot.summary.staleSources, color: "gray" },
    { name: "Failures", value: snapshot.summary.recentFailures, color: "red" }
  ].filter((d) => d.value > 0);
  const donutTotal = donutData.reduce((acc, d) => acc + d.value, 0);

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
          <MetricTile
            label="New Extremes"
            value={String(snapshot.summary.newExtremes)}
            hint="Items hitting historic bounds."
          />
          <MetricTile
            label="Outliers"
            value={String(snapshot.summary.outliers)}
            hint="Prices far from canonical median."
          />
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

        <SimpleGrid cols={{ base: 1, lg: 2 }} spacing="md">
          <Panel>
            <Group justify="space-between" align="flex-end" wrap="wrap" gap="md">
              <div>
                <Title order={4}>Overview</Title>
                <Text size="sm" c="dimmed">
                  What changed since the last snapshot
                </Text>
              </div>
              <Badge variant="light" color="gray">
                {donutTotal} signals
              </Badge>
            </Group>
            {donutTotal === 0 ? (
              <Text c="dimmed" size="sm" mt="lg">
                No anomalies detected yet.
              </Text>
            ) : (
              <Group mt="lg" justify="center">
                <DonutChart
                  data={donutData}
                  size={220}
                  thickness={26}
                  withTooltip
                  tooltipDataSource="segment"
                  chartLabel={donutTotal}
                  valueFormatter={(v) => String(v)}
                />
              </Group>
            )}
          </Panel>

          <Panel variant="subtle">
            <Group justify="space-between" align="flex-end" wrap="wrap" gap="md">
              <div>
                <Title order={4}>How to use this</Title>
                <Text size="sm" c="dimmed">
                  A quick workflow for triage
                </Text>
              </div>
            </Group>
            <Stack gap="xs" mt="lg">
              <Text size="sm">
                1) Start with <Text component="span" fw={700} inherit>Last-Run Movers</Text> to validate obvious changes.
              </Text>
              <Text size="sm">
                2) Check <Text component="span" fw={700} inherit>Outliers</Text> for linking mistakes or currency mismatches.
              </Text>
              <Text size="sm">
                3) Use <Text component="span" fw={700} inherit>Coverage gaps</Text> to prioritize new links.
              </Text>
            </Stack>
          </Panel>
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

        <Panel>
          <Group justify="space-between" align="flex-end">
            <div>
              <Title order={4}>Streak trends</Title>
              <Text size="sm" c="dimmed">
                Sustained moves across the last 4 price points
              </Text>
            </div>
            <Badge variant="light" color="gray">
              {snapshot.streakTrends.sustainedDrops.length + snapshot.streakTrends.sustainedRises.length}
            </Badge>
          </Group>

          <SimpleGrid cols={{ base: 1, md: 2 }} spacing="md" mt="lg">
            <Stack gap="sm">
              <Group justify="space-between">
                <Text size="xs" tt="uppercase" fw={700} c="teal.2" className={text.tracking}>
                  Drops
                </Text>
                <Badge variant="light" color="gray">
                  {snapshot.streakTrends.sustainedDrops.length}
                </Badge>
              </Group>
              {snapshot.streakTrends.sustainedDrops.length > 0 ? (
                <Stack gap="sm">
                  {snapshot.streakTrends.sustainedDrops.map((t) => (
                    <StreakRow key={`${t.sourceSlug}:${t.itemId}:drop`} kind="drop" item={t} />
                  ))}
                </Stack>
              ) : (
                <Text c="dimmed" size="sm">
                  No sustained drops detected.
                </Text>
              )}
            </Stack>

            <Stack gap="sm">
              <Group justify="space-between">
                <Text size="xs" tt="uppercase" fw={700} c="yellow.2" className={text.tracking}>
                  Spikes
                </Text>
                <Badge variant="light" color="gray">
                  {snapshot.streakTrends.sustainedRises.length}
                </Badge>
              </Group>
              {snapshot.streakTrends.sustainedRises.length > 0 ? (
                <Stack gap="sm">
                  {snapshot.streakTrends.sustainedRises.map((t) => (
                    <StreakRow key={`${t.sourceSlug}:${t.itemId}:rise`} kind="rise" item={t} />
                  ))}
                </Stack>
              ) : (
                <Text c="dimmed" size="sm">
                  No sustained spikes detected.
                </Text>
              )}
            </Stack>
          </SimpleGrid>
        </Panel>

        <SimpleGrid cols={{ base: 1, lg: 2 }} spacing="md">
          <Panel>
            <Group justify="space-between" align="flex-end">
              <div>
                <Title order={4}>New extremes</Title>
                <Text size="sm" c="dimmed">
                  Items hitting new lows/highs (per source)
                </Text>
              </div>
              <Badge variant="light" color="gray">
                {snapshot.summary.newExtremes}
              </Badge>
            </Group>

            <SimpleGrid cols={{ base: 1, md: 2 }} spacing="md" mt="lg">
              <Stack gap="sm">
                <Group justify="space-between">
                  <Text size="xs" tt="uppercase" fw={700} c="teal.2" className={text.tracking}>
                    New lows
                  </Text>
                  <Badge variant="light" color="gray">
                    {snapshot.extremes.newLows.length}
                  </Badge>
                </Group>
                {snapshot.extremes.newLows.length > 0 ? (
                  <Stack gap="sm">
                    {snapshot.extremes.newLows.map((e) => (
                      <ExtremeRow key={`${e.sourceSlug}:${e.itemId}:low`} kind="low" item={e} />
                    ))}
                  </Stack>
                ) : (
                  <Text c="dimmed" size="sm">
                    No new lows detected yet.
                  </Text>
                )}
              </Stack>

              <Stack gap="sm">
                <Group justify="space-between">
                  <Text size="xs" tt="uppercase" fw={700} c="yellow.2" className={text.tracking}>
                    New highs
                  </Text>
                  <Badge variant="light" color="gray">
                    {snapshot.extremes.newHighs.length}
                  </Badge>
                </Group>
                {snapshot.extremes.newHighs.length > 0 ? (
                  <Stack gap="sm">
                    {snapshot.extremes.newHighs.map((e) => (
                      <ExtremeRow key={`${e.sourceSlug}:${e.itemId}:high`} kind="high" item={e} />
                    ))}
                  </Stack>
                ) : (
                  <Text c="dimmed" size="sm">
                    No new highs detected yet.
                  </Text>
                )}
              </Stack>
            </SimpleGrid>
          </Panel>

          <Panel>
            <Group justify="space-between" align="flex-end">
              <div>
                <Title order={4}>Outliers</Title>
                <Text size="sm" c="dimmed">
                  Linked products deviating from canonical median (needs 3+ sources)
                </Text>
              </div>
              <Badge variant="light" color="gray">
                {snapshot.summary.outliers}
              </Badge>
            </Group>

            <Stack gap="sm" mt="lg">
              {snapshot.outliers.length > 0 ? (
                snapshot.outliers.map((o) => (
                  <OutlierRow key={`${o.canonicalId}:${o.sourceSlug}:${o.itemId}`} outlier={o} />
                ))
              ) : (
                <Text c="dimmed" size="sm">
                  No outliers detected yet.
                </Text>
              )}
            </Stack>
          </Panel>
        </SimpleGrid>

        <Panel>
          <Group justify="space-between" align="flex-end">
            <div>
              <Title order={4}>Coverage & data quality</Title>
              <Text size="sm" c="dimmed">
                Where to focus linking and enrichment
              </Text>
            </div>
            <Group gap={8}>
              <Badge variant="light" color="gray">
                Unlinked {snapshot.coverage.totals.unlinkedProducts}
              </Badge>
              <Badge variant="light" color="gray">
                Missing price {snapshot.coverage.totals.missingPrices}
              </Badge>
            </Group>
          </Group>

          <SimpleGrid cols={{ base: 1, lg: 3 }} spacing="md" mt="lg">
            <div style={{ gridColumn: "span 2" }}>
              <div style={{ overflowX: "auto" }}>
                <Table withTableBorder withColumnBorders={false} highlightOnHover>
                  <Table.Thead>
                    <Table.Tr>
                      <Table.Th>Source</Table.Th>
                      <Table.Th ta="right">Coverage</Table.Th>
                      <Table.Th ta="right">Unlinked</Table.Th>
                      <Table.Th ta="right">Missing price</Table.Th>
                    </Table.Tr>
                  </Table.Thead>
                  <Table.Tbody>
                    {snapshot.coverage.sources.length > 0 ? (
                      snapshot.coverage.sources.map((row) => (
                        <Table.Tr key={row.sourceSlug}>
                          <Table.Td>
                            <Stack gap={2}>
                              <Group gap={8}>
                                <Text size="sm" fw={600}>
                                  {row.displayName}
                                </Text>
                                {row.enabled ? (
                                  <Badge variant="light" color="gray">
                                    enabled
                                  </Badge>
                                ) : (
                                  <Badge variant="light" color="dark">
                                    disabled
                                  </Badge>
                                )}
                              </Group>
                              <Text size="xs" c="dimmed">
                                Latest: {row.lastSeenAt ? fmtTs(row.lastSeenAt) : "—"}
                              </Text>
                            </Stack>
                          </Table.Td>
                          <Table.Td ta="right">
                            <Stack gap={2} align="flex-end">
                              <Text fw={700} className={text.mono} c="teal.2">
                                {row.coveragePct.toFixed(1)}%
                              </Text>
                              <Text size="xs" c="dimmed" className={text.mono}>
                                {row.totalProducts} items
                              </Text>
                            </Stack>
                          </Table.Td>
                          <Table.Td ta="right">
                            <Anchor
                              component={Link}
                              to={linkWorkbenchHref({ sourceSlug: row.sourceSlug, tab: "unlinked" })}
                              className={classes.coverageLink}
                            >
                              <Text fw={700} className={text.mono} c="yellow.2">
                                {row.unlinkedProducts}
                              </Text>
                            </Anchor>
                          </Table.Td>
                          <Table.Td ta="right">
                            <Text fw={700} className={text.mono} c="red.2">
                              {row.missingPrices}
                            </Text>
                          </Table.Td>
                        </Table.Tr>
                      ))
                    ) : (
                      <Table.Tr>
                        <Table.Td colSpan={4}>
                          <Text c="dimmed" size="sm">
                            No coverage metrics yet.
                          </Text>
                        </Table.Td>
                      </Table.Tr>
                    )}
                  </Table.Tbody>
                </Table>
              </div>
            </div>

            <Stack gap="sm">
              <Group justify="space-between">
                <Title order={5}>Thin canonical coverage</Title>
                <Badge variant="light" color="gray">
                  {snapshot.coverage.canonicalGaps.length}
                </Badge>
              </Group>
              {snapshot.coverage.canonicalGaps.length > 0 ? (
                <Stack gap="sm">
                  {snapshot.coverage.canonicalGaps.map((gap) => (
                    <CanonicalGapRow key={gap.canonicalId} gap={gap} />
                  ))}
                </Stack>
              ) : (
                <Text c="dimmed" size="sm">
                  All canonicals have 2+ links.
                </Text>
              )}
            </Stack>
          </SimpleGrid>
        </Panel>
      </Stack>
    </Container>
  );
}
