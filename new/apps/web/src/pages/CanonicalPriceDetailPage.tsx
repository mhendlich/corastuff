import { useQuery } from "convex/react";
import { useMemo } from "react";
import { Link, useParams } from "react-router-dom";
import {
  Anchor,
  Badge,
  Button,
  Container,
  Group,
  SimpleGrid,
  Stack,
  Table,
  Text,
  Title
} from "@mantine/core";
import { IconExternalLink, IconTimelineEvent } from "@tabler/icons-react";
import { PageHeader } from "../components/PageHeader";
import { Panel } from "../components/Panel";
import { PriceChart } from "../components/PriceChart";
import { pricesCanonicalComparison } from "../convexFns";
import { fmtMoney, fmtSignedNumber, fmtSignedPct } from "../lib/format";
import { fmtAgo, fmtTs } from "../lib/time";
import text from "../ui/text.module.css";

function productHref(sourceSlug: string, itemId: string) {
  return `/prices/product/${encodeURIComponent(sourceSlug)}/${encodeURIComponent(itemId)}`;
}

export function CanonicalPriceDetailPage(props: { sessionToken: string }) {
  const params = useParams();
  const canonicalId = params.canonicalId ? decodeURIComponent(params.canonicalId) : "";

  const detail = useQuery(pricesCanonicalComparison, {
    sessionToken: props.sessionToken,
    canonicalId,
    limitPerProduct: 800
  });

  const colors = [
    "var(--mantine-color-violet-4)",
    "var(--mantine-color-teal-4)",
    "var(--mantine-color-yellow-4)",
    "var(--mantine-color-blue-4)",
    "var(--mantine-color-pink-4)",
    "var(--mantine-color-indigo-4)"
  ];

  const chartCurrency = useMemo(() => {
    if (!detail) return null;
    const set = new Set<string>();
    for (const item of detail.items) {
      if (typeof item.currency === "string") set.add(item.currency);
      else if (item.history[0]?.currency) set.add(item.history[0]!.currency);
    }
    if (set.size === 1) return Array.from(set)[0]!;
    return null;
  }, [detail]);

  const chartSeries = useMemo(() => {
    if (!detail) return [];
    return detail.items
      .map((item, idx) => ({
        key: `${item.sourceSlug}:${item.itemId}`,
        label: item.sourceDisplayName,
        color: colors[idx % colors.length]!,
        points: item.history
          .slice()
          .reverse()
          .map((p) => ({ ts: p.ts, value: p.price }))
      }))
      .filter((s) => s.points.length > 0);
  }, [detail]);

  if (detail === undefined) {
    return (
      <Container size="xl" py="xl">
        <Text c="dimmed">Loading canonical comparison…</Text>
      </Container>
    );
  }

  if (detail === null) {
    return (
      <Container size="xl" py="xl">
        <Text c="dimmed">Canonical not found.</Text>
      </Container>
    );
  }

  return (
    <Container size="xl" py="xl">
      <Stack gap="lg">
        <PageHeader
          title={detail.canonical.name}
          subtitle="Compare linked source prices over time."
          right={
            <Button component={Link} to={`/products/${detail.canonical._id}`} variant="light">
              View canonical
            </Button>
          }
        />

        <Panel>
          <Group justify="space-between" wrap="wrap" gap="md">
            <Stack gap={2}>
              <Text size="xs" tt="uppercase" fw={700} c="dimmed">
                Linked sources
              </Text>
              <Text fw={800} size="xl" className={text.mono}>
                {detail.items.length}
              </Text>
            </Stack>
            {chartCurrency === null && detail.items.length > 1 ? (
              <Text size="sm" c="dimmed">
                Multiple currencies detected; chart values are still plotted on one axis.
              </Text>
            ) : null}
          </Group>
        </Panel>

        <Panel>
          <Text fw={700} mb="sm">
            Current prices
          </Text>
          <SimpleGrid cols={{ base: 1, md: 2, lg: 3 }} spacing="md">
            {detail.items.map((item) => {
              const key = `${item.sourceSlug}:${item.itemId}`;
              const best = detail.bestKey === key;
              return (
                <Panel
                  key={key}
                  variant={best ? "default" : "subtle"}
                  style={best ? { borderColor: "color-mix(in srgb, var(--mantine-color-teal-5) 55%, transparent)" } : undefined}
                >
                  <Group justify="space-between" align="flex-start" wrap="nowrap" gap="md">
                    <Stack gap={6} style={{ minWidth: 0 }}>
                      <Group gap="xs" wrap="wrap">
                        <Badge variant="light" color={best ? "teal" : "gray"} radius="xl">
                          {item.sourceDisplayName}
                        </Badge>
                        {best ? (
                          <Badge variant="filled" color="teal" radius="xl">
                            Best
                          </Badge>
                        ) : null}
                      </Group>
                      <Anchor component={Link} to={productHref(item.sourceSlug, item.itemId)} fw={700} lineClamp={2}>
                        {item.name ?? item.itemId}
                      </Anchor>
                      <Text size="xs" c="dimmed" className={text.mono} lineClamp={1}>
                        {item.itemId}
                      </Text>
                    </Stack>
                    <Stack gap={4} align="flex-end">
                      <Text fw={800} size="lg" className={text.mono}>
                        {fmtMoney(item.currentPrice, item.currency ?? chartCurrency)}
                      </Text>
                      {item.url ? (
                        <Anchor href={item.url} target="_blank" rel="noreferrer" size="xs" c="dimmed">
                          Open <IconExternalLink size={12} style={{ verticalAlign: "middle" }} />
                        </Anchor>
                      ) : null}
                    </Stack>
                  </Group>
                </Panel>
              );
            })}
          </SimpleGrid>
        </Panel>

        <Panel>
          <Text fw={700} mb="sm">
            Price comparison
          </Text>
          <PriceChart series={chartSeries} currency={chartCurrency} />
        </Panel>

        <Stack gap="lg">
          {detail.items.map((item) => {
            const points = item.history;
            const key = `${item.sourceSlug}:${item.itemId}`;
            return (
              <Panel key={key} variant="subtle">
                <Group justify="space-between" align="flex-end" wrap="wrap" gap="md">
                  <div>
                    <Title order={5}>{item.sourceDisplayName}</Title>
                    <Text size="sm" c="dimmed">
                      {points.length > 0 ? `Latest ${fmtTs(points[0]!.ts)} • ${fmtAgo(points[0]!.ts)}` : "No history yet"}
                    </Text>
                  </div>
                  <Button component={Link} to={productHref(item.sourceSlug, item.itemId)} leftSection={<IconTimelineEvent size={16} />}>
                    View full history
                  </Button>
                </Group>

                {points.length > 0 ? (
                  <div style={{ overflowX: "auto", marginTop: 16 }}>
                    <Table withTableBorder highlightOnHover>
                      <Table.Thead>
                        <Table.Tr>
                          <Table.Th>Date</Table.Th>
                          <Table.Th ta="right">Price</Table.Th>
                          <Table.Th ta="right">Δ</Table.Th>
                          <Table.Th ta="right">Δ%</Table.Th>
                        </Table.Tr>
                      </Table.Thead>
                      <Table.Tbody>
                        {points.slice(0, 50).map((pt, idx) => {
                          const prev = points[idx + 1];
                          const dAbs = prev ? pt.price - prev.price : null;
                          const dPct = prev && prev.price > 0 ? (dAbs! / prev.price) * 100 : null;
                          return (
                            <Table.Tr key={pt._id}>
                              <Table.Td>
                                <Text size="sm">{fmtTs(pt.ts)}</Text>
                              </Table.Td>
                              <Table.Td ta="right">
                                <Text className={text.mono}>{fmtMoney(pt.price, pt.currency ?? item.currency ?? chartCurrency)}</Text>
                              </Table.Td>
                              <Table.Td ta="right">
                                <Text
                                  className={text.mono}
                                  c={(dPct ?? 0) < 0 ? "teal.2" : (dPct ?? 0) > 0 ? "yellow.2" : "dimmed"}
                                >
                                  {fmtSignedNumber(dAbs, 2) ?? "—"}
                                </Text>
                              </Table.Td>
                              <Table.Td ta="right">
                                <Text
                                  className={text.mono}
                                  c={(dPct ?? 0) < 0 ? "teal.2" : (dPct ?? 0) > 0 ? "yellow.2" : "dimmed"}
                                >
                                  {fmtSignedPct(dPct, 1) ?? "—"}
                                </Text>
                              </Table.Td>
                            </Table.Tr>
                          );
                        })}
                      </Table.Tbody>
                    </Table>
                  </div>
                ) : (
                  <Text c="dimmed" size="sm" mt="md">
                    No price points ingested yet.
                  </Text>
                )}
              </Panel>
            );
          })}
        </Stack>
      </Stack>
    </Container>
  );
}

