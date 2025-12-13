import { useMutation, useQuery } from "convex/react";
import { useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import {
  Badge,
  Button,
  Container,
  Divider,
  Group,
  ScrollArea,
  Select,
  SimpleGrid,
  Stack,
  Table,
  Tabs,
  Text,
  TextInput,
  Title
} from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { IconLink, IconSearch, IconUnlink } from "@tabler/icons-react";
import { PageHeader } from "../components/PageHeader";
import { Panel } from "../components/Panel";
import { fmtTs } from "../lib/time";
import text from "../ui/text.module.css";
import { ProductRow } from "../features/linkProducts/components/ProductRow";
import {
  canonicalsList,
  linksCountsBySource,
  linksCreateCanonicalAndLink,
  linksGetForProduct,
  linksLink,
  linksListUnlinked,
  linksUnlink,
  pricesListForProduct,
  productsGetLatestByKey,
  productsListLatest,
  sourcesList,
  type CanonicalDoc,
  type LinkCountsBySource,
  type PricePointDoc
} from "../convexFns";

function money(price: number | null | undefined, currency: string | null | undefined) {
  if (typeof price !== "number") return "—";
  const c = currency ?? "";
  return `${price} ${c}`.trim();
}

export function LinkProductsPage(props: { sessionToken: string }) {
  const { sessionToken } = props;

  const [searchParams] = useSearchParams();
  const deepLinkSourceSlug = (searchParams.get("sourceSlug") ?? "").trim() || null;
  const deepLinkItemId = (searchParams.get("itemId") ?? "").trim() || null;
  const deepLinkTabParam = (searchParams.get("tab") ?? "").trim() || null;

  const deepLinkApplied = useRef({ source: false, tab: false, product: false });

  const sources = useQuery(sourcesList, { sessionToken }) ?? [];

  const [productSourceSlug, setProductSourceSlug] = useState<string | null>(null);
  useEffect(() => {
    if (sources.length === 0) return;
    if (deepLinkApplied.current.source) return;
    deepLinkApplied.current.source = true;

    if (deepLinkSourceSlug && sources.some((s) => s.slug === deepLinkSourceSlug)) {
      setProductSourceSlug(deepLinkSourceSlug);
      return;
    }
    if (!productSourceSlug) setProductSourceSlug(sources[0]!.slug);
  }, [productSourceSlug, sources, deepLinkSourceSlug]);

  const skip = "skip" as const;

  const [tab, setTab] = useState<"unlinked" | "latest">("unlinked");
  useEffect(() => {
    if (deepLinkApplied.current.tab) return;
    deepLinkApplied.current.tab = true;
    if (deepLinkTabParam === "latest" || deepLinkTabParam === "unlinked") setTab(deepLinkTabParam);
  }, [deepLinkTabParam]);

  const linkCounts =
    useQuery(
      linksCountsBySource,
      sources.length > 0 ? { sessionToken, sourceSlugs: sources.map((s) => s.slug) } : skip
    ) ?? [];
  const countsBySourceSlug = useMemo(
    () => new Map<string, LinkCountsBySource>(linkCounts.map((c) => [c.sourceSlug, c])),
    [linkCounts]
  );

  const products =
    useQuery(productsListLatest, productSourceSlug ? { sessionToken, limit: 25, sourceSlug: productSourceSlug } : skip) ??
    [];

  const [unlinkedQuery, setUnlinkedQuery] = useState("");
  const unlinked =
    useQuery(
      linksListUnlinked,
      productSourceSlug
        ? {
            sessionToken,
            sourceSlug: productSourceSlug,
            limit: 60,
            q: unlinkedQuery.trim() ? unlinkedQuery.trim() : undefined
          }
        : skip
    ) ?? [];

  const deepLinkedProduct =
    useQuery(
      productsGetLatestByKey,
      deepLinkSourceSlug && deepLinkItemId
        ? { sessionToken, sourceSlug: deepLinkSourceSlug, itemId: deepLinkItemId }
        : skip
    ) ?? null;

  const productByKey = useMemo(() => {
    const map = new Map<string, (typeof products)[number]>();
    for (const p of products) map.set(`${p.sourceSlug}:${p.itemId}`, p);
    for (const p of unlinked) map.set(`${p.sourceSlug}:${p.itemId}`, p);
    if (deepLinkedProduct) map.set(`${deepLinkedProduct.sourceSlug}:${deepLinkedProduct.itemId}`, deepLinkedProduct);
    return map;
  }, [products, unlinked, deepLinkedProduct]);

  const [selectedProductKey, setSelectedProductKey] = useState<{ sourceSlug: string; itemId: string } | null>(null);
  useEffect(() => {
    if (!deepLinkApplied.current.product && deepLinkSourceSlug && deepLinkItemId) {
      const key = `${deepLinkSourceSlug}:${deepLinkItemId}`;
      const p = productByKey.get(key);
      if (p) {
        deepLinkApplied.current.product = true;
        setSelectedProductKey({ sourceSlug: deepLinkSourceSlug, itemId: deepLinkItemId });
        return;
      }
    }

    const current =
      selectedProductKey && productByKey.get(`${selectedProductKey.sourceSlug}:${selectedProductKey.itemId}`);
    if (current) return;

    const first = unlinked[0] ?? products[0];
    if (first) setSelectedProductKey({ sourceSlug: first.sourceSlug, itemId: first.itemId });
    else setSelectedProductKey(null);
  }, [selectedProductKey, productByKey, products, unlinked, deepLinkSourceSlug, deepLinkItemId]);

  const selectedProduct = selectedProductKey
    ? productByKey.get(`${selectedProductKey.sourceSlug}:${selectedProductKey.itemId}`) ?? null
    : null;

  const pricePoints =
    useQuery(
      pricesListForProduct,
      selectedProductKey
        ? { sessionToken, sourceSlug: selectedProductKey.sourceSlug, itemId: selectedProductKey.itemId, limit: 120 }
        : skip
    ) ?? [];
  const pricePointsChrono: PricePointDoc[] = useMemo(() => [...pricePoints].reverse(), [pricePoints]);

  const [canonicalQuery, setCanonicalQuery] = useState("");
  const canonicals =
    useQuery(canonicalsList, {
      sessionToken,
      limit: 80,
      q: canonicalQuery.trim() ? canonicalQuery.trim() : undefined
    }) ?? [];

  const linkForProduct = useQuery(
    linksGetForProduct,
    selectedProductKey ? { sessionToken, sourceSlug: selectedProductKey.sourceSlug, itemId: selectedProductKey.itemId } : skip
  );

  const linkProduct = useMutation(linksLink);
  const unlinkProduct = useMutation(linksUnlink);
  const createCanonicalAndLink = useMutation(linksCreateCanonicalAndLink);

  const [selectedCanonicalId, setSelectedCanonicalId] = useState<string | null>(null);
  const [newCanonicalName, setNewCanonicalName] = useState("");
  const [linking, setLinking] = useState(false);
  const [linkError, setLinkError] = useState<string | null>(null);

  useEffect(() => {
    setLinkError(null);
    setSelectedCanonicalId(null);
    setNewCanonicalName(selectedProduct?.name ?? "");
  }, [selectedProductKey?.sourceSlug, selectedProductKey?.itemId, selectedProduct?.name]);

  const canonicalOptions: CanonicalDoc[] = useMemo(() => {
    const canonical = linkForProduct?.canonical;
    if (!canonical) return canonicals;
    if (canonicals.some((c) => c._id === canonical._id)) return canonicals;
    return [canonical, ...canonicals];
  }, [canonicals, linkForProduct?.canonical]);

  useEffect(() => {
    const linkedCanonicalId = linkForProduct?.link.canonicalId;
    if (linkedCanonicalId && selectedCanonicalId !== linkedCanonicalId) {
      setSelectedCanonicalId(linkedCanonicalId);
      return;
    }
    if (!selectedCanonicalId && canonicalOptions.length > 0) setSelectedCanonicalId(canonicalOptions[0]!._id);
  }, [selectedCanonicalId, linkForProduct?.link.canonicalId, canonicalOptions]);

  const sourceOptions = sources.map((s) => ({ value: s.slug, label: s.displayName }));
  const count = productSourceSlug ? countsBySourceSlug.get(productSourceSlug) ?? null : null;

  return (
    <Container size="xl" py="xl">
      <Stack gap="lg">
        <PageHeader
          title="Link products"
          subtitle="Pick a source product and link it to a canonical."
          right={
            <Group gap="sm">
              <Select
                label="Source"
                placeholder="Select source"
                data={sourceOptions}
                value={productSourceSlug}
                onChange={(v) => setProductSourceSlug(v)}
                w={280}
                searchable
                nothingFoundMessage="No sources"
              />
              {count ? (
                <Group gap={8} align="flex-end" pb={4}>
                  <Badge variant="light" color="gray">
                    {count.unlinked} unlinked
                  </Badge>
                  <Badge variant="light" color="gray">
                    {count.linked} linked
                  </Badge>
                </Group>
              ) : null}
            </Group>
          }
        />

        <SimpleGrid cols={{ base: 1, lg: 3 }} spacing="md">
          <Panel>
            <Tabs
              value={tab}
              onChange={(v) => setTab(v === "latest" ? "latest" : "unlinked")}
              variant="pills"
              radius="xl"
            >
              <Tabs.List grow>
                <Tabs.Tab value="unlinked">Unlinked</Tabs.Tab>
                <Tabs.Tab value="latest">Latest</Tabs.Tab>
              </Tabs.List>

              <Tabs.Panel value="unlinked" pt="md">
                <Stack gap="sm">
                  <TextInput
                    leftSection={<IconSearch size={16} />}
                    placeholder="Search name or itemId…"
                    value={unlinkedQuery}
                    onChange={(e) => setUnlinkedQuery(e.currentTarget.value)}
                    rightSection={
                      unlinkedQuery.trim() ? (
                        <Button
                          variant="subtle"
                          color="gray"
                          size="xs"
                          onClick={() => setUnlinkedQuery("")}
                          style={{ marginRight: 6 }}
                        >
                          Clear
                        </Button>
                      ) : null
                    }
                  />

                  {productSourceSlug === null ? (
                    <Text c="dimmed">Seed demo sources and run a scraper first.</Text>
                  ) : unlinked.length === 0 ? (
                    <Text c="dimmed">No unlinked products found.</Text>
                  ) : (
                    <ScrollArea h={520} offsetScrollbars scrollbarSize={8}>
                      <Stack gap="sm">
                        {unlinked.map((p) => (
                          <ProductRow
                            key={p._id}
                            product={p}
                            selected={
                              selectedProductKey?.sourceSlug === p.sourceSlug && selectedProductKey?.itemId === p.itemId
                            }
                            onClick={() => setSelectedProductKey({ sourceSlug: p.sourceSlug, itemId: p.itemId })}
                          />
                        ))}
                      </Stack>
                    </ScrollArea>
                  )}
                </Stack>
              </Tabs.Panel>

              <Tabs.Panel value="latest" pt="md">
                {productSourceSlug === null ? (
                  <Text c="dimmed">Seed demo sources to view products.</Text>
                ) : products.length === 0 ? (
                  <Text c="dimmed">No products yet.</Text>
                ) : (
                  <ScrollArea h={600} offsetScrollbars scrollbarSize={8}>
                    <Stack gap="sm">
                      {products.map((p) => (
                        <ProductRow
                          key={p._id}
                          product={p}
                          selected={
                            selectedProductKey?.sourceSlug === p.sourceSlug && selectedProductKey?.itemId === p.itemId
                          }
                          onClick={() => setSelectedProductKey({ sourceSlug: p.sourceSlug, itemId: p.itemId })}
                        />
                      ))}
                    </Stack>
                  </ScrollArea>
                )}
              </Tabs.Panel>
            </Tabs>
          </Panel>

          <Stack gap="md" style={{ gridColumn: "span 2" }}>
            <Panel>
              <Group justify="space-between" align="flex-start" wrap="wrap">
                <div>
                  <Title order={4}>Price history</Title>
                  <Text c="dimmed" size="sm">
                    {selectedProduct ? `${selectedProduct.sourceSlug} · ${selectedProduct.itemId}` : "Select a product"}
                  </Text>
                </div>
                {selectedProduct ? (
                  <Group gap={8}>
                    <Badge variant="light" color="gray">
                      {money(selectedProduct.lastPrice, selectedProduct.currency ?? null)}
                    </Badge>
                    <Badge variant="light" color="gray">
                      {pricePointsChrono.length} points
                    </Badge>
                  </Group>
                ) : null}
              </Group>
              <Divider my="md" />

              {selectedProduct === null ? (
                <Text c="dimmed">Select a product on the left.</Text>
              ) : pricePointsChrono.length === 0 ? (
                <Text c="dimmed">No price points yet.</Text>
              ) : (
                <ScrollArea h={240} offsetScrollbars scrollbarSize={8}>
                  <Table striped highlightOnHover withTableBorder>
                    <Table.Thead>
                      <Table.Tr>
                        <Table.Th>Timestamp</Table.Th>
                        <Table.Th style={{ textAlign: "right" }}>Price</Table.Th>
                      </Table.Tr>
                    </Table.Thead>
                    <Table.Tbody>
                      {pricePointsChrono.map((pt) => (
                        <Table.Tr key={pt._id}>
                          <Table.Td className={text.mono}>{fmtTs(pt.ts)}</Table.Td>
                          <Table.Td style={{ textAlign: "right" }} className={text.mono}>
                            {money(pt.price, pt.currency)}
                          </Table.Td>
                        </Table.Tr>
                      ))}
                    </Table.Tbody>
                  </Table>
                </ScrollArea>
              )}
            </Panel>

            <Panel>
              <Group justify="space-between" align="flex-start" wrap="wrap">
                <div>
                  <Title order={4}>Linking</Title>
                  <Text c="dimmed" size="sm">
                    {selectedProduct ? `${selectedProduct.sourceSlug} · ${selectedProduct.itemId}` : "Select a product"}
                  </Text>
                </div>
              </Group>

              {linkError ? (
                <Text c="red.2" size="sm" mt="md">
                  link error: {linkError}
                </Text>
              ) : null}

              <Divider my="md" />

              {selectedProduct === null ? (
                <Text c="dimmed">Select a product on the left.</Text>
              ) : linkForProduct === undefined ? (
                <Text c="dimmed">Loading link…</Text>
              ) : (
                <Stack gap="md">
                  <Panel variant="subtle" radius="md" p="md">
                    <Group justify="space-between" align="flex-start" wrap="wrap">
                      <div style={{ minWidth: 0 }}>
                        <Text size="xs" c="dimmed" tt="uppercase" fw={700} className={text.tracking}>
                          Current canonical
                        </Text>
                        <Text fw={700} mt={6} lineClamp={1}>
                          {linkForProduct?.canonical
                            ? linkForProduct.canonical.name
                            : linkForProduct
                              ? "Missing canonical"
                              : "Unlinked"}
                        </Text>
                        {linkForProduct?.canonical?.description ? (
                          <Text size="sm" c="dimmed" mt={4} lineClamp={2}>
                            {linkForProduct.canonical.description}
                          </Text>
                        ) : null}
                      </div>
                      <Button
                        leftSection={<IconUnlink size={16} />}
                        variant="default"
                        disabled={!linkForProduct || linking}
                        loading={linking}
                        onClick={async () => {
                          setLinking(true);
                          setLinkError(null);
                          try {
                            await unlinkProduct({
                              sessionToken,
                              sourceSlug: selectedProduct.sourceSlug,
                              itemId: selectedProduct.itemId
                            });
                            notifications.show({ title: "Unlinked", message: selectedProduct.name });
                          } catch (err) {
                            setLinkError(err instanceof Error ? err.message : String(err));
                          } finally {
                            setLinking(false);
                          }
                        }}
                      >
                        Unlink
                      </Button>
                    </Group>
                  </Panel>

                  <SimpleGrid cols={{ base: 1, md: 2 }} spacing="md">
                    <Panel variant="subtle" radius="md" p="md">
                      <Text size="xs" c="dimmed" tt="uppercase" fw={700} className={text.tracking}>
                        Link to existing canonical
                      </Text>
                      <Stack gap="sm" mt="sm">
                        <TextInput
                          leftSection={<IconSearch size={16} />}
                          placeholder="Search canonicals…"
                          value={canonicalQuery}
                          onChange={(e) => setCanonicalQuery(e.currentTarget.value)}
                        />
                        <Select
                          placeholder="Select canonical…"
                          value={selectedCanonicalId}
                          onChange={setSelectedCanonicalId}
                          data={canonicalOptions.map((c) => ({ value: c._id, label: c.name }))}
                          searchable
                          nothingFoundMessage="No results"
                        />
                        <Button
                          leftSection={<IconLink size={16} />}
                          disabled={!selectedCanonicalId || linking}
                          loading={linking}
                          onClick={async () => {
                            if (!selectedCanonicalId || !selectedProduct) return;
                            setLinking(true);
                            setLinkError(null);
                            try {
                              await linkProduct({
                                sessionToken,
                                canonicalId: selectedCanonicalId,
                                sourceSlug: selectedProduct.sourceSlug,
                                itemId: selectedProduct.itemId
                              });
                              notifications.show({ title: "Linked", message: selectedProduct.name });
                            } catch (err) {
                              setLinkError(err instanceof Error ? err.message : String(err));
                            } finally {
                              setLinking(false);
                            }
                          }}
                        >
                          Link
                        </Button>
                      </Stack>
                    </Panel>

                    <Panel variant="subtle" radius="md" p="md">
                      <Text size="xs" c="dimmed" tt="uppercase" fw={700} className={text.tracking}>
                        Create canonical + link
                      </Text>
                      <Stack gap="sm" mt="sm">
                        <TextInput
                          placeholder="Canonical name"
                          value={newCanonicalName}
                          onChange={(e) => setNewCanonicalName(e.currentTarget.value)}
                        />
                        <Button
                          variant="light"
                          disabled={linking || !newCanonicalName.trim()}
                          loading={linking}
                          onClick={async () => {
                            if (!selectedProduct) return;
                            setLinking(true);
                            setLinkError(null);
                            try {
                              await createCanonicalAndLink({
                                sessionToken,
                                sourceSlug: selectedProduct.sourceSlug,
                                itemId: selectedProduct.itemId,
                                name: newCanonicalName.trim()
                              });
                              setCanonicalQuery("");
                              notifications.show({ title: "Created + linked", message: newCanonicalName.trim() });
                            } catch (err) {
                              setLinkError(err instanceof Error ? err.message : String(err));
                            } finally {
                              setLinking(false);
                            }
                          }}
                        >
                          Create + link
                        </Button>
                      </Stack>
                    </Panel>
                  </SimpleGrid>
                </Stack>
              )}
            </Panel>
          </Stack>
        </SimpleGrid>
      </Stack>
    </Container>
  );
}
