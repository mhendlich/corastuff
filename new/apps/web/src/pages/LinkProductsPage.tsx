import { useMutation, useQuery } from "convex/react";
import { useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import {
  ActionIcon,
  Avatar,
  Badge,
  Button,
  Checkbox,
  Container,
  Divider,
  Group,
  ScrollArea,
  Select,
  SimpleGrid,
  Stack,
  NumberInput,
  Switch,
  Table,
  Tabs,
  Text,
  TextInput,
  Title
} from "@mantine/core";
import { useDebouncedValue } from "@mantine/hooks";
import { notifications } from "@mantine/notifications";
import { IconLink, IconRefresh, IconSearch, IconUnlink } from "@tabler/icons-react";
import { PageHeader } from "../components/PageHeader";
import { Panel } from "../components/Panel";
import { fuseFilter, makeFuse } from "../lib/fuzzy";
import { fmtTs } from "../lib/time";
import text from "../ui/text.module.css";
import { ProductRow } from "../features/linkProducts/components/ProductRow";
import {
  canonicalsList,
  linksCountsBySource,
  linksCreateCanonicalAndLink,
  linksGetForProduct,
  linksBulkLink,
  linksLink,
  linksListUnlinkedPage,
  linksSuggestCanonicalsForProduct,
  linksSmartSuggestions,
  linksUnlink,
  pricesListForProduct,
  productsGetLatestByKey,
  productsListLatest,
  sourcesList,
  type CanonicalDoc,
  type LinkCountsBySource,
  type LinkSuggestion,
  type LinksBulkLinkResult,
  type PricePointDoc,
  type ProductLatestDoc,
  type SmartSuggestionGroup,
  type UnlinkedPage
} from "../convexFns";
import classes from "./LinkProductsPage.module.css";

function money(price: number | null | undefined, currency: string | null | undefined) {
  if (typeof price !== "number") return "—";
  const c = currency ?? "";
  return `${price} ${c}`.trim();
}

function keyForProduct(p: { sourceSlug: string; itemId: string }) {
  return `${p.sourceSlug}:${p.itemId}`;
}

export function LinkProductsPage(props: { sessionToken: string }) {
  const { sessionToken } = props;

  const [searchParams] = useSearchParams();
  const deepLinkSourceSlug = (searchParams.get("sourceSlug") ?? "").trim() || null;
  const deepLinkSourceSlugs = (searchParams.get("sourceSlugs") ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const deepLinkItemId = (searchParams.get("itemId") ?? "").trim() || null;
  const deepLinkTabParam = (searchParams.get("tab") ?? "").trim() || null;

  const deepLinkApplied = useRef({ sources: false, tab: false, product: false });

  const sources = useQuery(sourcesList, { sessionToken }) ?? [];

  const [selectedSourceSlugs, setSelectedSourceSlugs] = useState<string[]>([]);
  useEffect(() => {
    if (sources.length === 0) return;
    if (deepLinkApplied.current.sources) return;
    deepLinkApplied.current.sources = true;

    const available = new Set(sources.map((s) => s.slug));
    const fromUrl = Array.from(
      new Set([...(deepLinkSourceSlug ? [deepLinkSourceSlug] : []), ...deepLinkSourceSlugs])
    ).filter((s) => available.has(s));

    if (fromUrl.length > 0) {
      setSelectedSourceSlugs(fromUrl);
      return;
    }
    setSelectedSourceSlugs(sources.map((s) => s.slug));
  }, [sources, deepLinkSourceSlug, deepLinkSourceSlugs.join(",")]);

  const skip = "skip" as const;

  const [tab, setTab] = useState<"unlinked" | "latest">("unlinked");
  useEffect(() => {
    if (deepLinkApplied.current.tab) return;
    deepLinkApplied.current.tab = true;
    if (deepLinkTabParam === "latest" || deepLinkTabParam === "unlinked") setTab(deepLinkTabParam);
  }, [deepLinkTabParam]);

  const [countsNonce, setCountsNonce] = useState(0);
  const [queueNonce, setQueueNonce] = useState(0);
  const refresh = () => {
    setCountsNonce((n) => n + 1);
    setQueueNonce((n) => n + 1);
  };

  const linkCounts =
    useQuery(
      linksCountsBySource,
      sources.length > 0 ? { sessionToken, sourceSlugs: sources.map((s) => s.slug), nonce: countsNonce } : skip
    ) ?? [];

  const countsBySourceSlug = useMemo(
    () => new Map<string, LinkCountsBySource>(linkCounts.map((c) => [c.sourceSlug, c])),
    [linkCounts]
  );

  const activeSourceSlug = selectedSourceSlugs[0] ?? null;
  const productsLatest =
    useQuery(productsListLatest, activeSourceSlug ? { sessionToken, limit: 40, sourceSlug: activeSourceSlug } : skip) ??
    [];

  const [sourceFilter, setSourceFilter] = useState("");
  const [showZeroUnlinked, setShowZeroUnlinked] = useState(false);
  const visibleSources = useMemo(() => {
    const selected = new Set(selectedSourceSlugs);
    const ordered = [...sources].sort((a, b) => a.displayName.localeCompare(b.displayName));
    const fuse = makeFuse(ordered, { keys: ["slug", "displayName"] });
    const fuzzy = fuseFilter(ordered, fuse, sourceFilter);
    return fuzzy.filter((s) => {
      const counts = countsBySourceSlug.get(s.slug);
      if (!showZeroUnlinked && !selected.has(s.slug) && counts && counts.unlinked === 0) return false;
      return true;
    });
  }, [sources, sourceFilter, showZeroUnlinked, selectedSourceSlugs, countsBySourceSlug]);

  const [queueQuery, setQueueQuery] = useState("");
  const [debouncedQueueQuery] = useDebouncedValue(queueQuery, 250);
  const normalizedQueueQuery = debouncedQueueQuery.trim() ? debouncedQueueQuery.trim() : "";

  const [queueOffset, setQueueOffset] = useState(0);
  const queuePageSize = 60;
  const queueResetKey = `${tab}:${selectedSourceSlugs.slice().sort().join(",")}:${normalizedQueueQuery}`;

  const queuePage: UnlinkedPage | undefined =
    useQuery(
      linksListUnlinkedPage,
      tab === "unlinked" && selectedSourceSlugs.length > 0
        ? {
            sessionToken,
            sourceSlugs: selectedSourceSlugs,
            offset: queueOffset,
            limit: queuePageSize,
            q: normalizedQueueQuery || undefined,
            nonce: queueNonce
          }
        : skip
    ) ?? undefined;

  const appendedOffset = useRef<number | null>(null);
  const [queueItems, setQueueItems] = useState<ProductLatestDoc[]>([]);
  const [bulkSelectedKeys, setBulkSelectedKeys] = useState<Set<string>>(() => new Set());
  useEffect(() => {
    appendedOffset.current = null;
    setQueueOffset(0);
    setQueueItems([]);
    setBulkSelectedKeys(new Set());
  }, [queueResetKey]);

  useEffect(() => {
    if (tab !== "unlinked" && bulkSelectedKeys.size > 0) setBulkSelectedKeys(new Set());
  }, [tab, bulkSelectedKeys.size]);

  useEffect(() => {
    if (!queuePage) return;
    if (appendedOffset.current === queueOffset) return;
    appendedOffset.current = queueOffset;

    setQueueItems((prev) => {
      const next = queueOffset === 0 ? [...queuePage.items] : [...prev, ...queuePage.items];
      const seen = new Set<string>();
      const out: ProductLatestDoc[] = [];
      for (const p of next) {
        const key = keyForProduct(p);
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(p);
      }
      return out;
    });
  }, [queuePage, queueOffset]);

  useEffect(() => {
    if (bulkSelectedKeys.size === 0) return;
    const allowed = new Set(queueItems.map((p) => keyForProduct(p)));
    setBulkSelectedKeys((prev) => {
      if (prev.size === 0) return prev;
      const next = new Set<string>();
      for (const k of prev) {
        if (allowed.has(k)) next.add(k);
      }
      return next.size === prev.size ? prev : next;
    });
  }, [queueItems, bulkSelectedKeys.size]);

  const deepLinkedProduct =
    useQuery(
      productsGetLatestByKey,
      deepLinkSourceSlug && deepLinkItemId
        ? { sessionToken, sourceSlug: deepLinkSourceSlug, itemId: deepLinkItemId }
        : skip
    ) ?? null;

  const productByKey = useMemo(() => {
    const map = new Map<string, ProductLatestDoc>();
    for (const p of productsLatest) map.set(keyForProduct(p), p);
    for (const p of queueItems) map.set(keyForProduct(p), p);
    if (deepLinkedProduct) map.set(keyForProduct(deepLinkedProduct), deepLinkedProduct);
    return map;
  }, [productsLatest, queueItems, deepLinkedProduct]);

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

    const first = (tab === "unlinked" ? queueItems[0] : productsLatest[0]) ?? queueItems[0] ?? productsLatest[0];
    if (first) setSelectedProductKey({ sourceSlug: first.sourceSlug, itemId: first.itemId });
    else setSelectedProductKey(null);
  }, [selectedProductKey, productByKey, productsLatest, queueItems, deepLinkSourceSlug, deepLinkItemId, tab]);

  const selectedProduct = selectedProductKey
    ? productByKey.get(`${selectedProductKey.sourceSlug}:${selectedProductKey.itemId}`) ?? null
    : null;

  const queueIndex = useMemo(() => {
    if (!selectedProductKey) return -1;
    return queueItems.findIndex((p) => p.sourceSlug === selectedProductKey.sourceSlug && p.itemId === selectedProductKey.itemId);
  }, [queueItems, selectedProductKey]);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      const tag = target?.tagName?.toLowerCase() ?? "";
      if (tag === "input" || tag === "textarea" || (target as any)?.isContentEditable) return;

      if (tab !== "unlinked") return;
      if (queueItems.length === 0) return;
      if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
      e.preventDefault();

      const idx = queueIndex >= 0 ? queueIndex : 0;
      const nextIdx = e.key === "ArrowDown" ? Math.min(queueItems.length - 1, idx + 1) : Math.max(0, idx - 1);
      const next = queueItems[nextIdx];
      if (next) setSelectedProductKey({ sourceSlug: next.sourceSlug, itemId: next.itemId });
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [queueIndex, queueItems, tab]);

  const pricePoints =
    useQuery(
      pricesListForProduct,
      selectedProductKey
        ? { sessionToken, sourceSlug: selectedProductKey.sourceSlug, itemId: selectedProductKey.itemId, limit: 120 }
        : skip
    ) ?? [];
  const pricePointsChrono: PricePointDoc[] = useMemo(() => [...pricePoints].reverse(), [pricePoints]);

  const [canonicalQuery, setCanonicalQuery] = useState("");
  const canonicals = useQuery(canonicalsList, { sessionToken, limit: 250 }) ?? [];

  const linkForProduct = useQuery(
    linksGetForProduct,
    selectedProductKey ? { sessionToken, sourceSlug: selectedProductKey.sourceSlug, itemId: selectedProductKey.itemId } : skip
  );

  const linkProduct = useMutation(linksLink);
  const bulkLinkProducts = useMutation(linksBulkLink);
  const unlinkProduct = useMutation(linksUnlink);
  const createCanonicalAndLink = useMutation(linksCreateCanonicalAndLink);

  const [selectedCanonicalId, setSelectedCanonicalId] = useState<string | null>(null);
  const [keepCanonical, setKeepCanonical] = useState(false);
  const [newCanonicalName, setNewCanonicalName] = useState("");
  const [linking, setLinking] = useState(false);
  const [bulkLinking, setBulkLinking] = useState(false);
  const [linkError, setLinkError] = useState<string | null>(null);

  useEffect(() => {
    setLinkError(null);
    if (!keepCanonical) setSelectedCanonicalId(null);
    setNewCanonicalName(selectedProduct?.name ?? "");
  }, [keepCanonical, selectedProductKey?.sourceSlug, selectedProductKey?.itemId, selectedProduct?.name]);

  const canonicalOptions: CanonicalDoc[] = useMemo(() => {
    const canonical = linkForProduct?.canonical;
    if (!canonical) return canonicals;
    if (canonicals.some((c) => c._id === canonical._id)) return canonicals;
    return [canonical, ...canonicals];
  }, [canonicals, linkForProduct?.canonical]);

  const canonicalFuse = useMemo(
    () => makeFuse(canonicalOptions, { keys: ["name", "description", "_id"] }),
    [canonicalOptions]
  );

  const filteredCanonicals: CanonicalDoc[] = useMemo(() => {
    const fuzzy = fuseFilter(canonicalOptions, canonicalFuse, canonicalQuery, 60);
    if (!selectedCanonicalId) return fuzzy;
    const selected = canonicalOptions.find((c) => c._id === selectedCanonicalId);
    if (!selected) return fuzzy;
    if (fuzzy.some((c) => c._id === selected._id)) return fuzzy;
    return [selected, ...fuzzy];
  }, [canonicalOptions, canonicalFuse, canonicalQuery, selectedCanonicalId]);

  useEffect(() => {
    const linkedCanonicalId = linkForProduct?.link.canonicalId;
    if (!keepCanonical && linkedCanonicalId && selectedCanonicalId !== linkedCanonicalId) {
      setSelectedCanonicalId(linkedCanonicalId);
      return;
    }
    if (!selectedCanonicalId && canonicalOptions.length > 0) setSelectedCanonicalId(canonicalOptions[0]!._id);
  }, [keepCanonical, selectedCanonicalId, linkForProduct?.link.canonicalId, canonicalOptions]);

  const count = selectedProduct ? countsBySourceSlug.get(selectedProduct.sourceSlug) ?? null : null;

  const suggestions: LinkSuggestion[] =
    useQuery(
      linksSuggestCanonicalsForProduct,
      selectedProductKey
        ? { sessionToken, sourceSlug: selectedProductKey.sourceSlug, itemId: selectedProductKey.itemId, limit: 6 }
        : skip
    ) ?? [];

  const [smartSuggestionsNonce, setSmartSuggestionsNonce] = useState(0);
  const [dismissedSuggestionCanonicals, setDismissedSuggestionCanonicals] = useState<Set<string>>(() => new Set());
  const [smartMinConfidencePct, setSmartMinConfidencePct] = useState(() => {
    try {
      const raw = window.localStorage.getItem("linkProducts.smartMinConfidencePct");
      const n = raw ? Number(raw) : 85;
      if (!Number.isFinite(n)) return 85;
      return Math.max(50, Math.min(99, Math.round(n)));
    } catch {
      return 85;
    }
  });
  const [smartMinConfidenceAppliedPct, setSmartMinConfidenceAppliedPct] = useState(smartMinConfidencePct);

  useEffect(() => {
    try {
      window.localStorage.setItem("linkProducts.smartMinConfidencePct", String(smartMinConfidencePct));
    } catch {
      // ignore
    }
  }, [smartMinConfidencePct]);

  const smartSuggestions: SmartSuggestionGroup[] =
    useQuery(
      linksSmartSuggestions,
      tab === "unlinked" && selectedSourceSlugs.length > 0
        ? {
            sessionToken,
            sourceSlugs: selectedSourceSlugs,
            limit: 18,
            minConfidence: smartMinConfidenceAppliedPct / 100,
            nonce: smartSuggestionsNonce
          }
        : skip
    ) ?? [];

  const visibleSmartSuggestions = useMemo(
    () => smartSuggestions.filter((s) => !dismissedSuggestionCanonicals.has(s.canonical._id)),
    [smartSuggestions, dismissedSuggestionCanonicals]
  );

  const removeFromQueueAndAdvance = (k: string) => {
    setQueueItems((prev) => {
      const idx = prev.findIndex((p) => keyForProduct(p) === k);
      const next = prev.filter((p) => keyForProduct(p) !== k);

      const selectedKey = selectedProductKey ? `${selectedProductKey.sourceSlug}:${selectedProductKey.itemId}` : null;
      if (selectedKey && selectedKey === k) {
        const candidate = prev[idx + 1] ?? prev[idx - 1] ?? next[0] ?? null;
        if (candidate) setSelectedProductKey({ sourceSlug: candidate.sourceSlug, itemId: candidate.itemId });
        else setSelectedProductKey(null);
      }
      return next;
    });
  };

  const removeManyFromQueueAndAdvance = (remove: Set<string>) => {
    setQueueItems((prev) => {
      if (remove.size === 0) return prev;
      const next = prev.filter((p) => !remove.has(keyForProduct(p)));

      const selectedKey = selectedProductKey ? `${selectedProductKey.sourceSlug}:${selectedProductKey.itemId}` : null;
      if (selectedKey && remove.has(selectedKey)) {
        const start = prev.findIndex((p) => keyForProduct(p) === selectedKey);
        let candidate: ProductLatestDoc | null = null;
        for (let i = start + 1; i < prev.length; i += 1) {
          const p = prev[i]!;
          if (!remove.has(keyForProduct(p))) {
            candidate = p;
            break;
          }
        }
        if (!candidate) {
          for (let i = start - 1; i >= 0; i -= 1) {
            const p = prev[i]!;
            if (!remove.has(keyForProduct(p))) {
              candidate = p;
              break;
            }
          }
        }
        if (candidate) setSelectedProductKey({ sourceSlug: candidate.sourceSlug, itemId: candidate.itemId });
        else setSelectedProductKey(next[0] ? { sourceSlug: next[0].sourceSlug, itemId: next[0].itemId } : null);
      }

      return next;
    });
  };

  function parseProductKey(k: string): { sourceSlug: string; itemId: string } | null {
    const idx = k.indexOf(":");
    if (idx <= 0) return null;
    const sourceSlug = k.slice(0, idx);
    const itemId = k.slice(idx + 1);
    if (!sourceSlug.trim() || !itemId.trim()) return null;
    return { sourceSlug, itemId };
  }

  return (
    <Container size="xl" py="xl">
      <Stack gap="lg">
        <PageHeader
          title="Link products"
          subtitle="Triage unlinked products and attach them to canonicals."
          right={
            <ActionIcon variant="light" size="lg" onClick={refresh} aria-label="Refresh">
              <IconRefresh size={18} />
            </ActionIcon>
          }
        />

        <div className={classes.shell}>
          <div className={classes.rail}>
            <Panel>
              <Stack gap="sm">
                <Group justify="space-between" align="flex-start" wrap="nowrap" gap="md">
                  <div style={{ minWidth: 0 }}>
                    <Title order={4}>Sources</Title>
                    <Text size="sm" c="dimmed" lineClamp={2}>
                      Select one or more sources to build an unlinked queue.
                    </Text>
                  </div>
                  <Group gap={8}>
                    <Button
                      size="xs"
                      variant="light"
                      onClick={() => setSelectedSourceSlugs(sources.map((s) => s.slug))}
                      disabled={sources.length === 0}
                    >
                      All
                    </Button>
                    <Button size="xs" variant="subtle" color="gray" onClick={() => setSelectedSourceSlugs([])}>
                      None
                    </Button>
                  </Group>
                </Group>

                <TextInput
                  leftSection={<IconSearch size={16} />}
                  placeholder="Filter sources…"
                  value={sourceFilter}
                  onChange={(e) => setSourceFilter(e.currentTarget.value)}
                />

                <Checkbox
                  checked={showZeroUnlinked}
                  onChange={(e) => setShowZeroUnlinked(e.currentTarget.checked)}
                  label="Show sources with 0 unlinked"
                />

                {visibleSources.length === 0 ? (
                  <Text c="dimmed" size="sm">
                    No sources match.
                  </Text>
                ) : (
                  <ScrollArea className={classes.scroll} offsetScrollbars scrollbarSize={8}>
                    <Stack gap="xs">
                      {visibleSources.map((s) => {
                        const selected = selectedSourceSlugs.includes(s.slug);
                        const c = countsBySourceSlug.get(s.slug) ?? null;
                        return (
                          <Panel
                            key={s.slug}
                            variant={selected ? "default" : "subtle"}
                            p="sm"
                            className={classes.sourceRow}
                            onClick={() => {
                              setSelectedSourceSlugs((prev) => {
                                const set = new Set(prev);
                                if (set.has(s.slug)) set.delete(s.slug);
                                else set.add(s.slug);
                                return Array.from(set);
                              });
                            }}
                          >
                            <Group justify="space-between" wrap="nowrap" gap="md">
                              <Group wrap="nowrap" gap="sm" style={{ minWidth: 0 }}>
                                <Checkbox checked={selected} readOnly />
                                <div className={classes.sourceName}>
                                  <Text fw={650} size="sm" lineClamp={1}>
                                    {s.displayName}
                                  </Text>
                                  <Text size="xs" c="dimmed" className={text.mono} lineClamp={1}>
                                    {s.slug}
                                  </Text>
                                </div>
                              </Group>
                              <div className={classes.queueMeta}>
                                {c ? (
                                  <>
                                    <Badge variant="light" color={c.unlinked > 0 ? "yellow" : "gray"}>
                                      {c.unlinked} unlinked
                                    </Badge>
                                    <Badge variant="light" color="gray">
                                      {c.linked} linked
                                    </Badge>
                                    {c.missingItemIds > 0 ? (
                                      <Badge variant="light" color="red">
                                        {c.missingItemIds} missing IDs
                                      </Badge>
                                    ) : null}
                                  </>
                                ) : (
                                  <Badge variant="light" color="gray">
                                    …
                                  </Badge>
                                )}
                              </div>
                            </Group>
                          </Panel>
                        );
                      })}
                    </Stack>
                  </ScrollArea>
                )}
              </Stack>
            </Panel>
          </div>

          <div className={classes.queue}>
            <Panel>
              <Tabs value={tab} onChange={(v) => setTab(v === "latest" ? "latest" : "unlinked")} variant="pills" radius="xl">
                <Tabs.List grow>
                  <Tabs.Tab value="unlinked">Unlinked</Tabs.Tab>
                  <Tabs.Tab value="latest">Latest</Tabs.Tab>
                </Tabs.List>

                <Tabs.Panel value="unlinked" pt="md">
                  <Stack gap="sm">
                    <TextInput
                      leftSection={<IconSearch size={16} />}
                      placeholder="Search name or itemId…"
                      value={queueQuery}
                      onChange={(e) => setQueueQuery(e.currentTarget.value)}
                      rightSection={
                        queueQuery.trim() ? (
                          <Button
                            variant="subtle"
                            color="gray"
                            size="xs"
                            onClick={() => setQueueQuery("")}
                            style={{ marginRight: 6 }}
                          >
                            Clear
                          </Button>
                        ) : null
                      }
                    />

                    {selectedSourceSlugs.length === 0 ? (
                      <Text c="dimmed" size="sm">
                        Select sources on the left to start.
                      </Text>
                    ) : queueItems.length === 0 ? (
                      <Text c="dimmed" size="sm">
                        No unlinked products found.
                      </Text>
                    ) : (
                      <>
                        {bulkSelectedKeys.size > 0 ? (
                          <Panel variant="subtle" radius="md" p="sm">
                            <Group justify="space-between" wrap="wrap" gap="sm">
                              <Group gap={8}>
                                <Badge variant="light" color="teal">
                                  {bulkSelectedKeys.size} selected
                                </Badge>
                                <Text size="xs" c="dimmed">
                                  Use the right panel to bulk-link.
                                </Text>
                              </Group>
                              <Group gap={8}>
                                <Button size="xs" variant="subtle" color="gray" onClick={() => setBulkSelectedKeys(new Set())}>
                                  Clear
                                </Button>
                                <Button
                                  size="xs"
                                  variant="light"
                                  onClick={() => setBulkSelectedKeys(new Set(queueItems.map((p) => keyForProduct(p))))}
                                >
                                  Select all
                                </Button>
                              </Group>
                            </Group>
                          </Panel>
                        ) : null}
                        <ScrollArea className={classes.scroll} offsetScrollbars scrollbarSize={8}>
                          <Stack gap="sm">
                            {queueItems.map((p) => (
                              <ProductRow
                                key={p._id}
                                product={p}
                                selected={
                                  selectedProductKey?.sourceSlug === p.sourceSlug && selectedProductKey?.itemId === p.itemId
                                }
                                checked={bulkSelectedKeys.has(keyForProduct(p))}
                                onCheckedChange={(checked) => {
                                  const k = keyForProduct(p);
                                  setBulkSelectedKeys((prev) => {
                                    const next = new Set(prev);
                                    if (checked) next.add(k);
                                    else next.delete(k);
                                    return next;
                                  });
                                }}
                                onClick={() => setSelectedProductKey({ sourceSlug: p.sourceSlug, itemId: p.itemId })}
                              />
                            ))}
                          </Stack>
                        </ScrollArea>

                        <Group justify="space-between">
                          <Text size="xs" c="dimmed">
                            Use ↑/↓ to move selection
                          </Text>
                          <Group gap={8}>
                            {queuePage?.truncated ? (
                              <Badge variant="light" color="gray">
                                truncated
                              </Badge>
                            ) : null}
                            <Button
                              variant="light"
                              size="xs"
                              disabled={!queuePage?.hasMore}
                              onClick={() => setQueueOffset(queueItems.length)}
                            >
                              Load more
                            </Button>
                          </Group>
                        </Group>
                      </>
                    )}
                  </Stack>
                </Tabs.Panel>

                <Tabs.Panel value="latest" pt="md">
                  <Stack gap="sm">
                    <Group justify="space-between" wrap="nowrap" gap="md">
                      <Text size="sm" c="dimmed" lineClamp={2}>
                        Showing latest items for{" "}
                        <Text component="span" fw={700} inherit>
                          {activeSourceSlug ?? "—"}
                        </Text>
                      </Text>
                      <Select
                        data={selectedSourceSlugs.map((s) => ({
                          value: s,
                          label: sources.find((src) => src.slug === s)?.displayName ?? s
                        }))}
                        value={activeSourceSlug}
                        onChange={(v) => {
                          if (!v) return;
                          setSelectedSourceSlugs((prev) => {
                            const next = prev.filter((s) => s !== v);
                            return [v, ...next];
                          });
                        }}
                        size="xs"
                        w={200}
                        searchable
                        nothingFoundMessage="No sources"
                      />
                    </Group>

                    {activeSourceSlug === null ? (
                      <Text c="dimmed" size="sm">
                        Select at least one source.
                      </Text>
                    ) : productsLatest.length === 0 ? (
                      <Text c="dimmed" size="sm">
                        No products yet.
                      </Text>
                    ) : (
                      <ScrollArea className={classes.scroll} offsetScrollbars scrollbarSize={8}>
                        <Stack gap="sm">
                          {productsLatest.map((p) => (
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
              </Tabs>
            </Panel>
          </div>

          <div className={classes.detail}>
            <Stack gap="md">
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
                  <Text c="dimmed">Select a product from the middle column.</Text>
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
                {selectedProduct === null ? (
                  <Text c="dimmed">Select a product to link.</Text>
                ) : (
                  <Stack gap="md">
                    <Panel variant="subtle" radius="md" p="md">
                      <Group justify="space-between" align="flex-start" wrap="wrap">
                        <div style={{ minWidth: 0 }}>
                          <Text size="xs" c="dimmed" tt="uppercase" fw={700} className={text.tracking}>
                            Selected product
                          </Text>
                          <Text fw={650} lineClamp={2} mt={4}>
                            {selectedProduct.name}
                          </Text>
                          <Group gap={8} mt={6} wrap="wrap">
                            <Badge variant="light" color="gray">
                              {selectedProduct.sourceSlug}
                            </Badge>
                            <Badge variant="light" color="gray" className={text.mono}>
                              {selectedProduct.itemId}
                            </Badge>
                            {count ? (
                              <Badge variant="light" color={count.unlinked > 0 ? "yellow" : "gray"}>
                                {count.unlinked} unlinked in source
                              </Badge>
                            ) : null}
                          </Group>
                        </div>
                        <Group gap="sm" align="flex-end">
                          {linkForProduct?.canonical ? (
                            <Badge variant="light" color="teal">
                              Linked
                            </Badge>
                          ) : (
                            <Badge variant="light" color="yellow">
                              Unlinked
                            </Badge>
                          )}
                          <Button
                            leftSection={<IconUnlink size={16} />}
                            variant="light"
                            color="gray"
                            disabled={!linkForProduct?.link || linking}
                            loading={linking}
                            onClick={async () => {
                              if (!selectedProduct) return;
                              setLinking(true);
                              setLinkError(null);
                              try {
                                await unlinkProduct({
                                  sessionToken,
                                  sourceSlug: selectedProduct.sourceSlug,
                                  itemId: selectedProduct.itemId
                                });
                                refresh();
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
                      </Group>
                    </Panel>

                    {linkError ? (
                      <Panel variant="subtle" radius="md" p="md">
                        <Text c="red" size="sm">
                          {linkError}
                        </Text>
                      </Panel>
                    ) : null}

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
                            data={filteredCanonicals.map((c) => ({ value: c._id, label: c.name }))}
                            searchable
                            nothingFoundMessage="No results"
                          />
                          <Switch
                            checked={keepCanonical}
                            onChange={(e) => setKeepCanonical(e.currentTarget.checked)}
                            label="Keep selected canonical while moving through the queue"
                          />

                          {selectedProduct && suggestions.length > 0 ? (
                            <Stack gap={6}>
                              <Text size="xs" c="dimmed" tt="uppercase" fw={700} className={text.tracking}>
                                Suggestions
                              </Text>
                              <Group gap={8} wrap="wrap">
                                {suggestions.map((s) => (
                                  <Button
                                    key={s.canonical._id}
                                    size="xs"
                                    variant={selectedCanonicalId === s.canonical._id ? "filled" : "light"}
                                    onClick={() => setSelectedCanonicalId(s.canonical._id)}
                                  >
                                    {Math.round(s.confidence * 100)}% · {s.canonical.name}
                                  </Button>
                                ))}
                              </Group>
                              <Text size="xs" c="dimmed" lineClamp={2}>
                                {suggestions[0] ? `Best match: ${Math.round(suggestions[0].confidence * 100)}% · ${suggestions[0].reason}` : ""}
                              </Text>
                            </Stack>
                          ) : null}
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
                                if (tab === "unlinked") removeFromQueueAndAdvance(keyForProduct(selectedProduct));
                                refresh();
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
                          {tab === "unlinked" && bulkSelectedKeys.size > 0 ? (
                            <Button
                              leftSection={<IconLink size={16} />}
                              color="teal"
                              disabled={!selectedCanonicalId || bulkLinking}
                              loading={bulkLinking}
                              onClick={async () => {
                                if (!selectedCanonicalId) return;
                                const parsed = Array.from(bulkSelectedKeys)
                                  .map(parseProductKey)
                                  .filter(Boolean) as Array<{ sourceSlug: string; itemId: string }>;
                                if (parsed.length === 0) return;

                                setBulkLinking(true);
                                setLinkError(null);
                                try {
                                  const result: LinksBulkLinkResult = await bulkLinkProducts({
                                    sessionToken,
                                    canonicalId: selectedCanonicalId,
                                    items: parsed
                                  });
                                  const processed = new Set(result.processed.map((p) => `${p.sourceSlug}:${p.itemId}`));
                                  removeManyFromQueueAndAdvance(processed);
                                  setBulkSelectedKeys(new Set());
                                  refresh();
                                  const messageParts = [`${result.created + result.changed + result.unchanged} linked`];
                                  if (result.missing > 0) messageParts.push(`${result.missing} missing`);
                                  notifications.show({ title: "Bulk linked", message: messageParts.join(" · ") });
                                } catch (err) {
                                  setLinkError(err instanceof Error ? err.message : String(err));
                                } finally {
                                  setBulkLinking(false);
                                }
                              }}
                            >
                              Bulk link {bulkSelectedKeys.size}
                            </Button>
                          ) : null}
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
                                if (tab === "unlinked") removeFromQueueAndAdvance(keyForProduct(selectedProduct));
                                setCanonicalQuery("");
                                refresh();
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
          </div>
        </div>

        {tab === "unlinked" ? (
          <Panel>
            <Group justify="space-between" align="flex-start" wrap="wrap" gap="md">
              <div style={{ minWidth: 0 }}>
                <Title order={4}>Smart suggestions</Title>
                <Text size="sm" c="dimmed" lineClamp={2}>
                  Review bulk link suggestions across selected sources. This is heuristic and may include false positives.
                </Text>
              </div>
              <Group gap={8}>
                <NumberInput
                  size="sm"
                  w={160}
                  min={50}
                  max={99}
                  step={1}
                  clampBehavior="strict"
                  hideControls
                  label="Min confidence"
                  value={smartMinConfidencePct}
                  onChange={(v) => {
                    if (typeof v !== "number" || !Number.isFinite(v)) return;
                    setSmartMinConfidencePct(Math.max(50, Math.min(99, Math.round(v))));
                  }}
                />
                <Button
                  size="sm"
                  variant="light"
                  onClick={() => {
                    setDismissedSuggestionCanonicals(new Set());
                    setSmartMinConfidenceAppliedPct(smartMinConfidencePct);
                    setSmartSuggestionsNonce((n) => n + 1);
                  }}
                  disabled={selectedSourceSlugs.length === 0}
                >
                  Rescan
                </Button>
                <Button
                  size="sm"
                  color="teal"
                  disabled={bulkLinking || visibleSmartSuggestions.length === 0}
                  loading={bulkLinking}
                  onClick={async () => {
                    if (bulkLinking) return;
                    const threshold = smartMinConfidenceAppliedPct / 100;
                    const apply = visibleSmartSuggestions.filter((s) => s.confidence >= threshold);
                    if (apply.length === 0) {
                      notifications.show({
                        title: "Nothing to apply",
                        message: `No suggestions at or above ${smartMinConfidenceAppliedPct}% confidence.`
                      });
                      return;
                    }

                    setBulkLinking(true);
                    setLinkError(null);
                    try {
                      const processed = new Set<string>();
                      const dismissed = new Set<string>();
                      let appliedGroups = 0;
                      let linked = 0;

                      for (const s of apply) {
                        const result: LinksBulkLinkResult = await bulkLinkProducts({
                          sessionToken,
                          canonicalId: s.canonical._id,
                          items: s.items.map((it) => ({ sourceSlug: it.sourceSlug, itemId: it.itemId }))
                        });
                        for (const p of result.processed) processed.add(`${p.sourceSlug}:${p.itemId}`);
                        dismissed.add(s.canonical._id);
                        appliedGroups += 1;
                        linked += result.created + result.changed + result.unchanged;
                      }

                      removeManyFromQueueAndAdvance(processed);
                      setDismissedSuggestionCanonicals((prev) => {
                        const next = new Set(prev);
                        for (const id of dismissed) next.add(id);
                        return next;
                      });
                      refresh();

                      notifications.show({
                        title: "Applied suggestions",
                        message: `${appliedGroups} groups · ${linked} linked`
                      });
                    } catch (err) {
                      setLinkError(err instanceof Error ? err.message : String(err));
                    } finally {
                      setBulkLinking(false);
                    }
                  }}
                >
                  Apply all
                </Button>
              </Group>
            </Group>

            <Divider my="md" />

            {selectedSourceSlugs.length === 0 ? (
              <Text c="dimmed" size="sm">
                Select sources on the left to generate suggestions.
              </Text>
            ) : visibleSmartSuggestions.length === 0 ? (
              <Text c="dimmed" size="sm">
                No suggestions yet.
              </Text>
            ) : (
              <ScrollArea h={300} offsetScrollbars scrollbarSize={8}>
                <Table highlightOnHover withTableBorder striped>
                  <Table.Thead>
                    <Table.Tr>
                      <Table.Th>Canonical</Table.Th>
                      <Table.Th style={{ width: 260 }}>Preview</Table.Th>
                      <Table.Th style={{ width: 180, textAlign: "right" }}>Actions</Table.Th>
                    </Table.Tr>
                  </Table.Thead>
                  <Table.Tbody>
                    {visibleSmartSuggestions.map((s) => (
                      <Table.Tr key={s.canonical._id}>
                      <Table.Td>
                        <Text fw={650} lineClamp={1}>
                          {s.canonical.name}
                        </Text>
                        <Text size="xs" c="dimmed" lineClamp={1}>
                          {s.count} items · {Math.round(s.confidence * 100)}% confidence
                        </Text>
                      </Table.Td>
                        <Table.Td>
                          <Group gap={6} wrap="wrap">
                            {s.items.slice(0, 8).map((it) => (
                              <Avatar key={`${it.sourceSlug}:${it.itemId}`} src={it.image?.mediaUrl ?? undefined} radius="sm" size={28}>
                                {it.name.slice(0, 1).toUpperCase()}
                              </Avatar>
                            ))}
                          </Group>
                          <Text size="xs" c="dimmed" lineClamp={1} mt={6}>
                            {s.items[0]?.reason ?? ""}
                          </Text>
                        </Table.Td>
                        <Table.Td style={{ textAlign: "right" }}>
                          <Group gap={8} justify="flex-end" wrap="nowrap">
                            <Button
                              size="xs"
                              color="teal"
                              variant="light"
                              disabled={bulkLinking}
                              loading={bulkLinking}
                              onClick={async () => {
                                if (bulkLinking) return;
                                setBulkLinking(true);
                                setLinkError(null);
                                try {
                                  const result: LinksBulkLinkResult = await bulkLinkProducts({
                                    sessionToken,
                                    canonicalId: s.canonical._id,
                                    items: s.items.map((it) => ({ sourceSlug: it.sourceSlug, itemId: it.itemId }))
                                  });
                                  const processed = new Set(result.processed.map((p) => `${p.sourceSlug}:${p.itemId}`));
                                  removeManyFromQueueAndAdvance(processed);
                                  refresh();
                                  setDismissedSuggestionCanonicals((prev) => new Set(prev).add(s.canonical._id));
                                  notifications.show({
                                    title: "Applied suggestion",
                                    message: `${result.created + result.changed + result.unchanged} linked`
                                  });
                                } catch (err) {
                                  setLinkError(err instanceof Error ? err.message : String(err));
                                } finally {
                                  setBulkLinking(false);
                                }
                              }}
                            >
                              Apply
                            </Button>
                            <Button
                              size="xs"
                              variant="subtle"
                              color="gray"
                              disabled={bulkLinking}
                              onClick={() =>
                                setDismissedSuggestionCanonicals((prev) => {
                                  const next = new Set(prev);
                                  next.add(s.canonical._id);
                                  return next;
                                })
                              }
                            >
                              Dismiss
                            </Button>
                          </Group>
                        </Table.Td>
                      </Table.Tr>
                    ))}
                  </Table.Tbody>
                </Table>
              </ScrollArea>
            )}
          </Panel>
        ) : null}
      </Stack>
    </Container>
  );
}
