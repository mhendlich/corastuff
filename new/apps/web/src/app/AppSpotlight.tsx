import { useMemo, useState } from "react";
import { useQuery } from "convex/react";
import { useNavigate } from "react-router-dom";
import { Badge, Group, Kbd, Stack, Text } from "@mantine/core";
import { Spotlight, type SpotlightActionData } from "@mantine/spotlight";
import {
  IconBarcode,
  IconChartLine,
  IconDatabase,
  IconLink,
  IconPackage,
  IconPlus,
  IconSearch,
  IconTimelineEvent
} from "@tabler/icons-react";
import { canonicalsList, productsListLatest, runsListRecent, sourcesList } from "../convexFns";
import { fuseFilter, makeFuse } from "../lib/fuzzy";
import { NAV_ITEMS } from "./nav";

function parseSourceItemId(q: string): { sourceSlug: string; itemId: string } | null {
  const s = q.trim();
  if (!s) return null;
  const m = s.match(/^prices\s+product\s+(\S+)\s+(.+)$/i);
  if (m) return { sourceSlug: m[1] ?? "", itemId: m[2] ?? "" };
  const m2 = s.match(/^(\S+)[/:]\s*(\S.+)$/);
  if (m2) return { sourceSlug: m2[1] ?? "", itemId: m2[2] ?? "" };
  return null;
}

function looksLikeId(q: string) {
  const s = q.trim();
  if (!s) return false;
  if (s.includes(" ")) return false;
  return /^[a-z0-9]{12,}$/i.test(s);
}

export function AppSpotlight(props: { sessionToken: string }) {
  const navigate = useNavigate();
  const [q, setQ] = useState("");

  const sources = useQuery(sourcesList, { sessionToken: props.sessionToken }) ?? [];
  const canonicals = useQuery(canonicalsList, { sessionToken: props.sessionToken, limit: 250 }) ?? [];
  const products = useQuery(productsListLatest, { sessionToken: props.sessionToken, limit: 250 }) ?? [];
  const runs = useQuery(runsListRecent, { sessionToken: props.sessionToken, limit: 120 }) ?? [];

  const actions = useMemo(() => {
    const navActions: SpotlightActionData[] = NAV_ITEMS.map((item) => ({
      id: `nav:${item.to}`,
      label: item.label,
      description: item.disabled ? "Coming soon" : undefined,
      leftSection: <item.icon size={18} />,
      onClick: () => {
        if (item.disabled) return;
        navigate(item.to);
      }
    }));

    const parsedProduct = parseSourceItemId(q);
    const jumpActions: SpotlightActionData[] = [];

    if (q.trim().startsWith("/")) {
      const path = q.trim();
      jumpActions.push({
        id: `jump:${path}`,
        label: `Go to ${path}`,
        description: "Jump to a route",
        leftSection: <IconSearch size={18} />,
        onClick: () => navigate(path)
      });
    }

    if (looksLikeId(q)) {
      const id = q.trim();
      jumpActions.push({
        id: `jump:canonical:${id}`,
        label: `Canonical: ${id}`,
        description: "Open /products/:id",
        leftSection: <IconPackage size={18} />,
        onClick: () => navigate(`/products/${id}`)
      });
      jumpActions.push({
        id: `jump:run:${id}`,
        label: `Run: ${id}`,
        description: "Open /scrapers/history/:runId",
        leftSection: <IconTimelineEvent size={18} />,
        onClick: () => navigate(`/scrapers/history/${id}`)
      });
    }

    if (parsedProduct?.sourceSlug && parsedProduct.itemId) {
      const sourceSlug = parsedProduct.sourceSlug;
      const itemId = parsedProduct.itemId;
      jumpActions.push({
        id: `jump:prices:${sourceSlug}:${itemId}`,
        label: `Price history: ${sourceSlug} / ${itemId}`,
        description: "Open /prices/product/:sourceSlug/:itemId",
        leftSection: <IconTimelineEvent size={18} />,
        onClick: () => navigate(`/prices/product/${encodeURIComponent(sourceSlug)}/${encodeURIComponent(itemId)}`)
      });
    }

    const quickActions: SpotlightActionData[] = [
      {
        id: "action:new-product",
        label: "New product",
        description: "Create a canonical product",
        leftSection: <IconPlus size={18} />,
        onClick: () => navigate("/products/new")
      },
      {
        id: "action:link-products",
        label: "Link products",
        description: "Open the linking workbench",
        leftSection: <IconLink size={18} />,
        onClick: () => navigate("/link")
      },
      {
        id: "action:prices",
        label: "Prices",
        description: "Browse source prices and deltas",
        leftSection: <IconTimelineEvent size={18} />,
        onClick: () => navigate("/prices")
      },
      {
        id: "action:insights",
        label: "Insights",
        description: "Review anomalies and coverage gaps",
        leftSection: <IconChartLine size={18} />,
        onClick: () => navigate("/insights")
      }
    ];

    const sourcesFuse = makeFuse(sources, { keys: ["slug", "displayName", "type"] });
    const canonicalsFuse = makeFuse(canonicals, { keys: ["name", "description", "_id"] });
    const productsFuse = makeFuse(products, { keys: ["name", "itemId", "sourceSlug"] });
    const runsFuse = makeFuse(runs, { keys: ["_id", "sourceSlug", "status", "error"] });

    const sourceMatches = fuseFilter(sources, sourcesFuse, q, 7);
    const canonicalMatches = fuseFilter(canonicals, canonicalsFuse, q, 7);
    const productMatches = fuseFilter(products, productsFuse, q, 7);
    const runMatches = fuseFilter(runs, runsFuse, q, 7);

    const sourceActions: SpotlightActionData[] = sourceMatches.map((s) => ({
      id: `source:${s.slug}`,
      label: s.displayName || s.slug,
      description: `${s.slug} · ${s.type}`,
      leftSection: <IconDatabase size={18} />,
      onClick: () => navigate(`/scrapers/sources/${s.slug}`)
    }));

    const canonicalActions: SpotlightActionData[] = canonicalMatches.map((c) => ({
      id: `canonical:${c._id}`,
      label: c.name,
      description: c.description ? "Canonical · " + c.description : "Canonical product",
      leftSection: <IconPackage size={18} />,
      onClick: () => navigate(`/products/${c._id}`)
    }));

    const productActions: SpotlightActionData[] = productMatches.map((p) => ({
      id: `product:${p.sourceSlug}:${p.itemId}`,
      label: p.name,
      description: `${p.sourceSlug} · ${p.itemId}`,
      leftSection: <IconBarcode size={18} />,
      onClick: () => navigate(`/prices/product/${encodeURIComponent(p.sourceSlug)}/${encodeURIComponent(p.itemId)}`)
    }));

    const runActions: SpotlightActionData[] = runMatches.map((r) => ({
      id: `run:${r._id}`,
      label: `${r.sourceSlug} · ${r.status}`,
      description: r.error ? `Run ${r._id} · ${r.error}` : `Run ${r._id}`,
      leftSection: <IconTimelineEvent size={18} />,
      onClick: () => navigate(`/scrapers/history/${r._id}`)
    }));

    const shouldShowSearchResults = q.trim().length > 0;

    return [
      ...(shouldShowSearchResults && jumpActions.length > 0 ? [{ group: "Jump", actions: jumpActions }] : []),
      ...(shouldShowSearchResults
        ? [
            { group: "Canonicals", actions: canonicalActions },
            { group: "Products", actions: productActions },
            { group: "Sources", actions: sourceActions },
            { group: "Runs", actions: runActions }
          ]
        : []),
      { group: "Actions", actions: quickActions },
      { group: "Navigate", actions: navActions }
    ];
  }, [navigate, q, sources, canonicals, products, runs]);

  return (
    <Spotlight
      actions={actions}
      shortcut={["mod + K", "mod + P"]}
      scrollable
      maxHeight={460}
      searchProps={{
        leftSection: <IconSearch size={16} />,
        placeholder: "Search canonicals, products, sources, runs…",
        value: q,
        onChange: (e) => setQ(e.currentTarget.value)
      }}
      nothingFound={
        <Stack gap={6}>
          <Text size="sm" c="dimmed">
            No matches.
          </Text>
          <Group gap={8} wrap="wrap">
            <Badge variant="light" color="gray">
              <Group gap={6}>
                <Kbd>Products</Kbd>
                <Text size="xs" c="dimmed">
                  canonicals
                </Text>
              </Group>
            </Badge>
            <Badge variant="light" color="gray">
              <Group gap={6}>
                <Kbd>source:item</Kbd>
                <Text size="xs" c="dimmed">
                  price history
                </Text>
              </Group>
            </Badge>
            <Badge variant="light" color="gray">
              <Group gap={6}>
                <Kbd>run</Kbd>
                <Text size="xs" c="dimmed">
                  scraper runs
                </Text>
              </Group>
            </Badge>
          </Group>
        </Stack>
      }
    />
  );
}
