import { useMemo, useState } from "react";
import { useQuery } from "convex/react";
import { Anchor, Badge, Box, Group, Loader, Paper, SimpleGrid, Stack, Table, Text, TextInput } from "@mantine/core";
import { IconAlertTriangle, IconEye, IconSearch, IconTrendingDown, IconTrendingUp } from "@tabler/icons-react";
import { Link } from "react-router-dom";
import type { AmazonPricingAction, AmazonPricingItem } from "../convexFns";
import { amazonPricingOpportunities } from "../convexFns";
import { fmtMoney, fmtSignedNumber, fmtSignedPct } from "../lib/format";
import classes from "./AmazonPricingPage.module.css";

function statusBadge(action: AmazonPricingAction) {
  if (action === "undercut") {
    return (
      <Badge color="red" variant="light" leftSection={<IconTrendingDown size={12} />}>
        Undercut
      </Badge>
    );
  }
  if (action === "raise") {
    return (
      <Badge color="teal" variant="light" leftSection={<IconTrendingUp size={12} />}>
        Raise
      </Badge>
    );
  }
  if (action === "watch") {
    return (
      <Badge color="gray" variant="light" leftSection={<IconEye size={12} />}>
        Watch
      </Badge>
    );
  }
  if (action === "missing_amazon") {
    return (
      <Badge color="yellow" variant="light" leftSection={<IconAlertTriangle size={12} />}>
        Missing Amazon
      </Badge>
    );
  }
  if (action === "missing_own_price") {
    return (
      <Badge color="yellow" variant="light" leftSection={<IconAlertTriangle size={12} />}>
        No Amazon price
      </Badge>
    );
  }
  return (
    <Badge color="yellow" variant="light" leftSection={<IconAlertTriangle size={12} />}>
      Missing retailers
    </Badge>
  );
}

function canonicalLabel(it: AmazonPricingItem) {
  return it.canonicalName?.trim() ? it.canonicalName : it.canonicalId;
}

export function AmazonPricingPage(props: { sessionToken: string }) {
  const data = useQuery(amazonPricingOpportunities, { sessionToken: props.sessionToken });
  const [q, setQ] = useState("");

  const filtered = useMemo(() => {
    if (!data) return null;
    const needle = q.trim().toLowerCase();
    if (!needle) return data.items;
    return data.items.filter((it) => canonicalLabel(it).toLowerCase().includes(needle));
  }, [data, q]);

  const groups = useMemo(() => {
    const items = filtered ?? [];
    return {
      undercut: items.filter((i) => i.action === "undercut"),
      all: items
    };
  }, [filtered]);

  if (!data) {
    return (
      <Group justify="center" py={96}>
        <Loader />
      </Group>
    );
  }

  return (
    <Stack gap="lg">
      <Paper withBorder radius="lg" p="lg">
        <SimpleGrid cols={4} spacing="lg">
          <Box>
            <Text size="xs" c="dimmed" tt="uppercase" fw={600}>
              Undercut now
            </Text>
            <Text size="xl" fw={700} className={classes.kpiValue}>
              {data.summary.undercutCount}
            </Text>
            <Text size="xs" c="dimmed">
              Total gap: {fmtMoney(data.summary.totalOverprice, "EUR")}
            </Text>
          </Box>
          <Box>
            <Text size="xs" c="dimmed" tt="uppercase" fw={600}>
              Raise now
            </Text>
            <Text size="xl" fw={700} className={classes.kpiValue}>
              {data.summary.raiseCount}
            </Text>
            <Text size="xs" c="dimmed">
              Potential gain: {fmtMoney(data.summary.totalPotentialGain, "EUR")}
            </Text>
          </Box>
          <Box>
            <Text size="xs" c="dimmed" tt="uppercase" fw={600}>
              Watching
            </Text>
            <Text size="xl" fw={700} className={classes.kpiValue}>
              {data.summary.watchCount}
            </Text>
            <Text size="xs" c="dimmed">
              Within tolerance
            </Text>
          </Box>
          <Box>
            <Text size="xs" c="dimmed" tt="uppercase" fw={600}>
              Missing data
            </Text>
            <Text size="xl" fw={700} className={classes.kpiValue}>
              {data.summary.missingDataCount}
            </Text>
            <Text size="xs" c="dimmed">
              No retailer or Amazon price yet
            </Text>
          </Box>
        </SimpleGrid>
      </Paper>

      <Paper withBorder radius="lg" p="lg">
        <Group justify="space-between" align="flex-end" gap="md">
          <Box>
            <Text fw={600}>Amazon Pricing</Text>
            <Text size="sm" c="dimmed">
              Compare Amazon storefront prices vs retailers for canonicals already linked to Amazon.
            </Text>
          </Box>
          <TextInput
            value={q}
            onChange={(e) => setQ(e.currentTarget.value)}
            placeholder="Search canonical…"
            leftSection={<IconSearch size={16} />}
            w={360}
          />
        </Group>
      </Paper>

      {groups.undercut.length > 0 ? (
        <Paper withBorder radius="lg" p="lg">
          <Group justify="space-between" mb="md">
            <Box>
              <Text fw={600}>Undercut Opportunities</Text>
              <Text size="sm" c="dimmed">
                Retailers are cheaper than your Amazon price.
              </Text>
            </Box>
            <Text size="sm" c="dimmed">
              {groups.undercut.length} items
            </Text>
          </Group>

          <Table.ScrollContainer minWidth={980}>
            <Table verticalSpacing="sm" highlightOnHover>
              <Table.Thead>
                <Table.Tr>
                  <Table.Th>Canonical</Table.Th>
                  <Table.Th>Amazon Price</Table.Th>
                  <Table.Th>Cheapest Retailer</Table.Th>
                  <Table.Th ta="right">Gap</Table.Th>
                  <Table.Th ta="right">Suggested</Table.Th>
                  <Table.Th ta="right">Actions</Table.Th>
                </Table.Tr>
              </Table.Thead>
              <Table.Tbody>
                {groups.undercut.map((it) => (
                  <Table.Tr key={it.canonicalId}>
                    <Table.Td>
                      <Stack gap={2}>
                        <Text fw={600}>{canonicalLabel(it)}</Text>
                        <Text size="xs" c="dimmed">
                          {it.competitorCount} retailers tracked
                        </Text>
                      </Stack>
                    </Table.Td>
                    <Table.Td>
                      <Stack gap={2}>
                        <Text fw={600} className={classes.tableCellMono}>
                          {fmtMoney(it.ownPrice, it.ownCurrency)}
                        </Text>
                        {it.primaryAmazon?.url ? (
                          <Anchor href={it.primaryAmazon.url} target="_blank" size="xs" c="dimmed">
                            {it.primaryAmazon.sourceDisplayName} • {it.primaryAmazon.itemId}
                          </Anchor>
                        ) : (
                          <Text size="xs" c="dimmed">
                            {it.primaryAmazon?.sourceDisplayName ?? "Amazon"} • {it.primaryAmazon?.itemId ?? "—"}
                          </Text>
                        )}
                      </Stack>
                    </Table.Td>
                    <Table.Td>
                      {it.competitorMin ? (
                        <Stack gap={2}>
                          <Text fw={600} className={classes.tableCellMono}>
                            {fmtMoney(it.competitorMin.price, it.competitorMin.currency ?? it.ownCurrency)}
                          </Text>
                          {it.competitorMin.url ? (
                            <Anchor href={it.competitorMin.url} target="_blank" size="xs" c="dimmed">
                              {it.competitorMin.sourceDisplayName}
                            </Anchor>
                          ) : (
                            <Text size="xs" c="dimmed">
                              {it.competitorMin.sourceDisplayName}
                            </Text>
                          )}
                        </Stack>
                      ) : (
                        <Text c="dimmed">—</Text>
                      )}
                    </Table.Td>
                    <Table.Td ta="right">
                      <Stack gap={2} align="flex-end">
                        <Text fw={600} c="red" className={classes.tableCellMono}>
                          {fmtSignedNumber(it.deltaAbs, 2)}
                        </Text>
                        <Text size="xs" c="dimmed" className={classes.tableCellMono}>
                          {fmtSignedPct(it.deltaPct, 1) ?? "—"}
                        </Text>
                      </Stack>
                    </Table.Td>
                    <Table.Td ta="right">
                      <Stack gap={2} align="flex-end">
                        <Text fw={600} className={classes.tableCellMono}>
                          {fmtMoney(it.suggestedPrice, it.ownCurrency)}
                        </Text>
                        <Text size="xs" c="dimmed">
                          {it.suggestedReason ?? "—"}
                        </Text>
                      </Stack>
                    </Table.Td>
                    <Table.Td ta="right">
                      <Group justify="flex-end" gap="sm">
                        <Anchor component={Link} to={`/prices/canonical/${it.canonicalId}`} size="sm">
                          History
                        </Anchor>
                        {it.primaryAmazon?.url ? (
                          <Anchor href={it.primaryAmazon.url} target="_blank" size="sm" c="dimmed">
                            Amazon
                          </Anchor>
                        ) : null}
                      </Group>
                    </Table.Td>
                  </Table.Tr>
                ))}
              </Table.Tbody>
            </Table>
          </Table.ScrollContainer>
        </Paper>
      ) : null}

      <Paper withBorder radius="lg" p="lg">
        <Group justify="space-between" mb="md">
          <Box>
            <Text fw={600}>All Tracked Amazon Products</Text>
            <Text size="sm" c="dimmed">
              Including watch items and gaps.
            </Text>
          </Box>
          <Text size="sm" c="dimmed">
            {groups.all.length} canonicals
          </Text>
        </Group>

        {groups.all.length ? (
          <Table.ScrollContainer minWidth={980}>
            <Table verticalSpacing="sm" highlightOnHover>
              <Table.Thead>
                <Table.Tr>
                  <Table.Th>Canonical</Table.Th>
                  <Table.Th>Status</Table.Th>
                  <Table.Th>Amazon</Table.Th>
                  <Table.Th>Retailer Min</Table.Th>
                  <Table.Th ta="right">Suggested</Table.Th>
                  <Table.Th ta="right">Actions</Table.Th>
                </Table.Tr>
              </Table.Thead>
              <Table.Tbody>
                {groups.all.map((it) => (
                  <Table.Tr key={it.canonicalId}>
                    <Table.Td>
                      <Text fw={600}>{canonicalLabel(it)}</Text>
                    </Table.Td>
                    <Table.Td>{statusBadge(it.action)}</Table.Td>
                    <Table.Td>
                      <Stack gap={2}>
                        <Text fw={600} className={classes.tableCellMono}>
                          {fmtMoney(it.ownPrice, it.ownCurrency)}
                        </Text>
                        {it.primaryAmazon?.url ? (
                          <Anchor href={it.primaryAmazon.url} target="_blank" size="xs" c="dimmed">
                            {it.primaryAmazon.sourceDisplayName} • {it.primaryAmazon.itemId}
                          </Anchor>
                        ) : (
                          <Text size="xs" c="dimmed">
                            {it.primaryAmazon?.sourceDisplayName ?? "Amazon"} • {it.primaryAmazon?.itemId ?? "—"}
                          </Text>
                        )}
                      </Stack>
                    </Table.Td>
                    <Table.Td>
                      {it.competitorMin ? (
                        <Stack gap={2}>
                          <Text fw={600} className={classes.tableCellMono}>
                            {fmtMoney(it.competitorMin.price, it.competitorMin.currency ?? it.ownCurrency)}
                          </Text>
                          <Text size="xs" c="dimmed">
                            {it.competitorMin.sourceDisplayName}
                          </Text>
                        </Stack>
                      ) : (
                        <Text c="dimmed">—</Text>
                      )}
                    </Table.Td>
                    <Table.Td ta="right">
                      {it.suggestedPrice !== null ? (
                        <Stack gap={2} align="flex-end">
                          <Text fw={600} className={classes.tableCellMono}>
                            {fmtMoney(it.suggestedPrice, it.ownCurrency)}
                          </Text>
                          <Text size="xs" c="dimmed">
                            {it.suggestedReason ?? "—"}
                          </Text>
                        </Stack>
                      ) : (
                        <Text c="dimmed">—</Text>
                      )}
                    </Table.Td>
                    <Table.Td ta="right">
                      <Group justify="flex-end" gap="sm">
                        <Anchor component={Link} to={`/prices/canonical/${it.canonicalId}`} size="sm">
                          History
                        </Anchor>
                        {it.primaryAmazon?.url ? (
                          <Anchor href={it.primaryAmazon.url} target="_blank" size="sm" c="dimmed">
                            Amazon
                          </Anchor>
                        ) : null}
                      </Group>
                    </Table.Td>
                  </Table.Tr>
                ))}
              </Table.Tbody>
            </Table>
          </Table.ScrollContainer>
        ) : (
          <Paper withBorder radius="md" p="xl" bg="var(--mantine-color-dark-7)">
            <Text c="dimmed" ta="center">
              No Amazon-linked canonicals yet. Link at least one Amazon product to a canonical to start tracking.
            </Text>
          </Paper>
        )}
      </Paper>
    </Stack>
  );
}

