import { useQuery } from "convex/react";
import { useMemo } from "react";
import { Link, useParams } from "react-router-dom";
import { Anchor, Badge, Button, Container, Group, Stack, Table, Text } from "@mantine/core";
import { IconExternalLink, IconLink, IconTimelineEvent } from "@tabler/icons-react";
import { PageHeader } from "../components/PageHeader";
import { Panel } from "../components/Panel";
import { PriceChart } from "../components/PriceChart";
import { pricesProductDetail } from "../convexFns";
import { fmtMoney, fmtSignedNumber, fmtSignedPct } from "../lib/format";
import { fmtAgo, fmtTs } from "../lib/time";
import text from "../ui/text.module.css";

function productHref(sourceSlug: string, itemId: string) {
  return `/prices/product/${encodeURIComponent(sourceSlug)}/${encodeURIComponent(itemId)}`;
}

export function ProductPriceDetailPage(props: { sessionToken: string }) {
  const params = useParams();
  const sourceSlug = params.sourceSlug ? decodeURIComponent(params.sourceSlug) : "";
  const itemId = params.itemId ? decodeURIComponent(params.itemId) : "";

  const detail = useQuery(pricesProductDetail, {
    sessionToken: props.sessionToken,
    sourceSlug,
    itemId,
    limit: 1500
  });

  const currency = useMemo(() => {
    if (!detail) return null;
    if (typeof detail.product.currency === "string") return detail.product.currency;
    const first = detail.history[0];
    return first?.currency ?? null;
  }, [detail]);

  const currentPrice = useMemo(() => {
    if (!detail) return null;
    if (typeof detail.product.lastPrice === "number") return detail.product.lastPrice;
    return detail.history[0]?.price ?? null;
  }, [detail]);

  const chartSeries = useMemo(() => {
    if (!detail) return [];
    const pts = detail.history
      .slice()
      .reverse()
      .map((p) => ({ ts: p.ts, value: p.price }));
    return [
      {
        key: "price",
        label: detail.source.displayName,
        color: "var(--mantine-color-violet-4)",
        points: pts
      }
    ];
  }, [detail]);

  if (detail === undefined) {
    return (
      <Container size="xl" py="xl">
        <Text c="dimmed">Loading price history…</Text>
      </Container>
    );
  }

  if (detail === null) {
    return (
      <Container size="xl" py="xl">
        <Text c="dimmed">Product not found.</Text>
      </Container>
    );
  }

  const prevPrice = typeof detail.product.prevPrice === "number" ? detail.product.prevPrice : null;
  const changeAbs =
    typeof detail.product.priceChange === "number"
      ? detail.product.priceChange
      : currentPrice !== null && prevPrice !== null
        ? currentPrice - prevPrice
        : null;
  const changePct =
    typeof detail.product.priceChangePct === "number"
      ? detail.product.priceChangePct
      : prevPrice !== null && prevPrice > 0 && changeAbs !== null
        ? (changeAbs / prevPrice) * 100
        : null;

  const changeAbsStr = fmtSignedNumber(changeAbs, 2);
  const changePctStr = fmtSignedPct(changePct, 1);
  const delta = changeAbsStr && changePctStr ? `${changeAbsStr} (${changePctStr})` : changeAbsStr ?? changePctStr ?? "—";

  return (
    <Container size="xl" py="xl">
      <Stack gap="lg">
        <PageHeader
          title={detail.product.name}
          subtitle={
            <Group gap="xs" wrap="wrap">
              <Badge variant="light" color="gray" radius="xl">
                {detail.source.displayName}
              </Badge>
              <Text size="sm" c="dimmed" className={text.mono}>
                {detail.product.itemId}
              </Text>
              <Text size="sm" c="dimmed">
                last seen {fmtAgo(detail.product.lastSeenAt)}
              </Text>
            </Group>
          }
          right={
            <Group gap="sm">
              {detail.product.url ? (
                <Button
                  component="a"
                  href={detail.product.url}
                  target="_blank"
                  rel="noreferrer"
                  leftSection={<IconExternalLink size={16} />}
                  variant="light"
                >
                  Open
                </Button>
              ) : null}
              <Button
                component={Link}
                to={productHref(detail.source.slug, detail.product.itemId)}
                leftSection={<IconTimelineEvent size={16} />}
                variant="light"
              >
                Refresh
              </Button>
            </Group>
          }
        />

        {detail.canonical ? (
          <Panel variant="subtle">
            <Group justify="space-between" wrap="wrap" gap="md">
              <Stack gap={2}>
                <Text fw={700}>Linked to canonical</Text>
                <Anchor component={Link} to={`/products/${detail.canonical._id}`} c="dimmed" size="sm" lineClamp={1}>
                  {detail.canonical.name}
                </Anchor>
              </Stack>
              <Group gap="sm">
                <Button
                  component={Link}
                  to={`/products/${detail.canonical._id}`}
                  leftSection={<IconLink size={16} />}
                  variant="light"
                >
                  View links
                </Button>
                <Button
                  component={Link}
                  to={`/prices/canonical/${detail.canonical._id}`}
                  leftSection={<IconTimelineEvent size={16} />}
                >
                  Compare prices
                </Button>
              </Group>
            </Group>
          </Panel>
        ) : null}

        <Panel>
          <Group justify="space-between" wrap="wrap" gap="md">
            <Stack gap={2}>
              <Text size="xs" tt="uppercase" fw={700} c="dimmed">
                Current
              </Text>
              <Text fw={800} size="xl" className={text.mono}>
                {fmtMoney(currentPrice, currency)}
              </Text>
            </Stack>
            <Stack gap={2} align="flex-end">
              <Text size="xs" tt="uppercase" fw={700} c="dimmed">
                Change
              </Text>
              <Text
                fw={800}
                size="lg"
                className={text.mono}
                c={(changePct ?? 0) < 0 ? "teal.2" : (changePct ?? 0) > 0 ? "yellow.2" : "dimmed"}
              >
                {delta}
              </Text>
              {typeof detail.product.prevPriceAt === "number" ? (
                <Text size="xs" c="dimmed">
                  vs {fmtTs(detail.product.prevPriceAt)}
                </Text>
              ) : null}
            </Stack>
          </Group>
        </Panel>

        <Panel>
          <Text fw={700} mb="sm">
            Price chart
          </Text>
          <PriceChart series={chartSeries} currency={currency} />
        </Panel>

        <Panel>
          <Group justify="space-between" wrap="wrap" gap="md">
            <Text fw={700}>History</Text>
            <Text size="sm" c="dimmed">
              Showing {detail.history.length} points
            </Text>
          </Group>
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
                {detail.history.map((pt, idx) => {
                  const prev = detail.history[idx + 1];
                  const dAbs = prev ? pt.price - prev.price : null;
                  const dPct = prev && prev.price > 0 ? (dAbs! / prev.price) * 100 : null;
                  return (
                    <Table.Tr key={pt._id}>
                      <Table.Td>
                        <Text size="sm">{fmtTs(pt.ts)}</Text>
                      </Table.Td>
                      <Table.Td ta="right">
                        <Text className={text.mono}>{fmtMoney(pt.price, pt.currency ?? currency)}</Text>
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
        </Panel>
      </Stack>
    </Container>
  );
}

