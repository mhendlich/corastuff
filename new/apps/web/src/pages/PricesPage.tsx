import { useQuery } from "convex/react";
import { useMemo, useState } from "react";
import { useDebouncedValue } from "@mantine/hooks";
import { DatePickerInput } from "@mantine/dates";
import { useNavigate } from "react-router-dom";
import {
  Badge,
  Button,
  Card,
  Container,
  Group,
  NumberInput,
  SegmentedControl,
  Select,
  SimpleGrid,
  Stack,
  Table,
  Text,
  TextInput,
  Title
} from "@mantine/core";
import { IconArrowRight, IconSearch, IconTimelineEvent } from "@tabler/icons-react";
import { PageHeader } from "../components/PageHeader";
import { Panel } from "../components/Panel";
import { canonicalsList, pricesOverview, sourcesList, type CanonicalDoc, type PricesOverview } from "../convexFns";
import { fmtMoney, fmtSignedNumber, fmtSignedPct } from "../lib/format";
import { fmtAgo, fmtTs } from "../lib/time";
import text from "../ui/text.module.css";
import classes from "./PricesPage.module.css";

function productHref(sourceSlug: string, itemId: string) {
  return `/prices/product/${encodeURIComponent(sourceSlug)}/${encodeURIComponent(itemId)}`;
}

function canonicalHref(canonicalId: string) {
  return `/prices/canonical/${encodeURIComponent(canonicalId)}`;
}

function fmtDelta(abs: number | null, pct: number | null) {
  const absStr = fmtSignedNumber(abs, 2);
  const pctStr = fmtSignedPct(pct, 1);
  if (absStr && pctStr) return `${absStr} (${pctStr})`;
  return absStr ?? pctStr ?? "—";
}

export function PricesPage(props: { sessionToken: string }) {
  const navigate = useNavigate();

  const [view, setView] = useState<"table" | "cards">("table");
  const [sourceSlug, setSourceSlug] = useState<string | null>(null);
  const [q, setQ] = useState("");
  const [minPrice, setMinPrice] = useState<string | number | undefined>(undefined);
  const [maxPrice, setMaxPrice] = useState<string | number | undefined>(undefined);
  const [seenRange, setSeenRange] = useState<[string | null, string | null]>([null, null]);
  const [selectedCanonicalId, setSelectedCanonicalId] = useState<string | null>(null);

  const [qDebounced] = useDebouncedValue(q, 250);
  const [minDebounced] = useDebouncedValue(minPrice, 250);
  const [maxDebounced] = useDebouncedValue(maxPrice, 250);

  const sources = useQuery(sourcesList, { sessionToken: props.sessionToken }) ?? [];
  const canonicals: CanonicalDoc[] = useQuery(canonicalsList, { sessionToken: props.sessionToken, limit: 200 }) ?? [];

  const overview: PricesOverview | undefined = useQuery(pricesOverview, {
    sessionToken: props.sessionToken,
    sourceSlug: sourceSlug ?? undefined,
    q: qDebounced.trim() ? qDebounced.trim() : undefined,
    minPrice: typeof minDebounced === "number" ? minDebounced : undefined,
    maxPrice: typeof maxDebounced === "number" ? maxDebounced : undefined,
    limitPerSource: 250
  });

  const sourceOptions = useMemo(
    () =>
      sources
        .slice()
        .sort((a, b) => a.displayName.localeCompare(b.displayName))
        .map((s) => ({ value: s.slug, label: s.displayName })),
    [sources]
  );

  const canonicalOptions = useMemo(
    () =>
      canonicals
        .slice()
        .sort((a, b) => a.name.localeCompare(b.name))
        .map((c) => ({ value: c._id, label: c.name })),
    [canonicals]
  );

  const sections = useMemo(() => {
    const raw = overview?.sources ?? [];
    const [from, to] = seenRange;
    if (!from && !to) return raw;

    const fromTs = from ? new Date(`${from}T00:00:00`).getTime() : null;
    const toTs = to ? new Date(`${to}T23:59:59.999`).getTime() : null;

    return raw.map((s) => ({
      ...s,
      products: s.products.filter((p) => {
        if (fromTs !== null && p.lastSeenAt < fromTs) return false;
        if (toTs !== null && p.lastSeenAt > toTs) return false;
        return true;
      })
    }));
  }, [overview, seenRange]);

  const totalVisible = useMemo(
    () => sections.reduce((acc, s) => acc + (s.products?.length ?? 0), 0),
    [sections]
  );

  return (
    <Container size="xl" py="xl">
      <Stack gap="lg">
        <PageHeader
          title="Prices"
          subtitle={
            overview ? (
              <>
                Showing {totalVisible} items. Snapshot generated {fmtTs(overview.generatedAt)}.
              </>
            ) : (
              "Loading price overview…"
            )
          }
          right={
            <SegmentedControl
              value={view}
              onChange={(v) => setView(v as "table" | "cards")}
              data={[
                { value: "table", label: "Table" },
                { value: "cards", label: "Cards" }
              ]}
            />
          }
        />

        <Panel>
          <Stack gap="md">
            <SimpleGrid cols={{ base: 1, md: 2, lg: 5 }} spacing="md">
              <TextInput
                leftSection={<IconSearch size={16} />}
                placeholder="Search product name or SKU…"
                value={q}
                onChange={(e) => setQ(e.currentTarget.value)}
              />
              <Select
                data={sourceOptions}
                clearable
                searchable
                placeholder="Filter by source…"
                value={sourceSlug}
                onChange={setSourceSlug}
              />
              <NumberInput
                placeholder="Min price…"
                value={minPrice}
                onChange={(v) => setMinPrice(v)}
                min={0}
                allowDecimal
                decimalScale={2}
              />
              <NumberInput
                placeholder="Max price…"
                value={maxPrice}
                onChange={(v) => setMaxPrice(v)}
                min={0}
                allowDecimal
                decimalScale={2}
              />
              <DatePickerInput
                type="range"
                clearable
                allowSingleDateInRange
                placeholder="Seen between…"
                value={seenRange}
                onChange={setSeenRange}
              />
            </SimpleGrid>

            <Group justify="space-between" wrap="wrap" gap="md">
              <Group gap="sm" wrap="wrap">
                <Select
                  data={canonicalOptions}
                  clearable
                  searchable
                  placeholder="Pick a canonical to compare…"
                  value={selectedCanonicalId}
                  onChange={setSelectedCanonicalId}
                  w={360}
                />
                <Button
                  leftSection={<IconTimelineEvent size={16} />}
                  rightSection={<IconArrowRight size={16} />}
                  disabled={!selectedCanonicalId}
                  onClick={() => selectedCanonicalId && navigate(canonicalHref(selectedCanonicalId))}
                >
                  View canonical prices
                </Button>
              </Group>

              <Button
                variant="subtle"
                color="gray"
                onClick={() => {
                  setQ("");
                  setSourceSlug(null);
                  setMinPrice(undefined);
                  setMaxPrice(undefined);
                  setSeenRange([null, null]);
                }}
              >
                Reset filters
              </Button>
            </Group>
          </Stack>
        </Panel>

        {overview === undefined ? (
          <Text c="dimmed">Loading products…</Text>
        ) : (
          <Stack gap="lg">
            {sections.filter((s) => s.products.length > 0).length === 0 ? (
              <Text c="dimmed">No priced items match the current filters.</Text>
            ) : null}

            {sections
              .filter((s) => s.products.length > 0)
              .map((s) => (
                <Panel key={s.sourceSlug} variant="subtle">
                  <Group justify="space-between" align="flex-end" wrap="wrap" gap="md">
                    <div>
                      <Title order={4}>{s.displayName}</Title>
                      <Text size="sm" c="dimmed">
                        {s.enabled ? "Enabled" : "Disabled"} • last success {fmtAgo(s.lastSuccessfulAt)}
                      </Text>
                    </div>
                    <Badge variant="light" color="gray" className={text.mono}>
                      {s.products.length}
                    </Badge>
                  </Group>

                  {view === "table" ? (
                    <div style={{ overflowX: "auto", marginTop: 16 }}>
                      <Table withTableBorder highlightOnHover>
                        <Table.Thead>
                          <Table.Tr>
                            <Table.Th>Product</Table.Th>
                            <Table.Th ta="right">Price</Table.Th>
                            <Table.Th ta="right">Change</Table.Th>
                            <Table.Th ta="right">Seen</Table.Th>
                          </Table.Tr>
                        </Table.Thead>
                        <Table.Tbody>
                          {s.products.map((p) => (
                            <Table.Tr
                              key={`${p.sourceSlug}:${p.itemId}`}
                              className={classes.row}
                              onClick={() => navigate(productHref(p.sourceSlug, p.itemId))}
                            >
                              <Table.Td className={classes.nameCell}>
                                <Group wrap="nowrap" gap="md">
                                  {p.image?.mediaUrl ? (
                                    <img
                                      src={p.image.mediaUrl}
                                      alt={p.name}
                                      loading="lazy"
                                      className={classes.thumb}
                                    />
                                  ) : (
                                    <div className={classes.thumb} />
                                  )}
                                  <Stack gap={2} style={{ minWidth: 0 }}>
                                    <Text fw={700} lineClamp={1} title={p.name}>
                                      {p.name}
                                    </Text>
                                    <Text size="xs" c="dimmed" className={text.mono} lineClamp={1}>
                                      {p.itemId}
                                    </Text>
                                  </Stack>
                                </Group>
                              </Table.Td>
                              <Table.Td ta="right">
                                <Text className={text.mono}>{fmtMoney(p.lastPrice, p.currency)}</Text>
                              </Table.Td>
                              <Table.Td ta="right">
                                <Text
                                  className={text.mono}
                                  c={(p.priceChangePct ?? 0) < 0 ? "teal.2" : (p.priceChangePct ?? 0) > 0 ? "yellow.2" : "dimmed"}
                                >
                                  {fmtDelta(p.priceChange, p.priceChangePct)}
                                </Text>
                              </Table.Td>
                              <Table.Td ta="right">
                                <Text size="sm" c="dimmed">
                                  {fmtAgo(p.lastSeenAt)}
                                </Text>
                              </Table.Td>
                            </Table.Tr>
                          ))}
                        </Table.Tbody>
                      </Table>
                    </div>
                  ) : (
                    <SimpleGrid cols={{ base: 1, md: 2, lg: 3 }} spacing="md" mt="lg">
                      {s.products.map((p) => (
                        <Card
                          key={`${p.sourceSlug}:${p.itemId}`}
                          withBorder
                          radius="lg"
                          p="md"
                          style={{ cursor: "pointer" }}
                          onClick={() => navigate(productHref(p.sourceSlug, p.itemId))}
                        >
                          {p.image?.mediaUrl ? (
                            <img src={p.image.mediaUrl} alt={p.name} loading="lazy" className={classes.cardThumb} />
                          ) : (
                            <div className={classes.cardThumb} />
                          )}
                          <Stack gap={6} mt="sm">
                            <Text fw={700} lineClamp={2} title={p.name}>
                              {p.name}
                            </Text>
                            <Text size="xs" c="dimmed" className={text.mono} lineClamp={1}>
                              {p.itemId}
                            </Text>
                            <Group justify="space-between" align="baseline" wrap="nowrap">
                              <Text fw={700} className={text.mono}>
                                {fmtMoney(p.lastPrice, p.currency)}
                              </Text>
                              <Text
                                size="sm"
                                className={text.mono}
                                c={(p.priceChangePct ?? 0) < 0 ? "teal.2" : (p.priceChangePct ?? 0) > 0 ? "yellow.2" : "dimmed"}
                              >
                                {fmtDelta(p.priceChange, p.priceChangePct)}
                              </Text>
                            </Group>
                            <Text size="xs" c="dimmed">
                              {fmtAgo(p.lastSeenAt)}
                            </Text>
                          </Stack>
                        </Card>
                      ))}
                    </SimpleGrid>
                  )}
                </Panel>
              ))}
          </Stack>
        )}
      </Stack>
    </Container>
  );
}
