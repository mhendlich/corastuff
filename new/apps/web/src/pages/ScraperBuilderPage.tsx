import { useAction, useMutation, useQuery } from "convex/react";
import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import {
  Anchor,
  Badge,
  Button,
  Container,
  Divider,
  Group,
  Paper,
  ScrollArea,
  Select,
  Stack,
  Text,
  TextInput,
  Textarea,
  Title
} from "@mantine/core";
import { useDebouncedValue } from "@mantine/hooks";
import { notifications } from "@mantine/notifications";
import { IconArrowRight, IconCopy, IconPlayerPlay, IconTrash, IconX } from "@tabler/icons-react";
import type { SourceType } from "@corastuff/shared";
import { eventSummary } from "../features/dashboard/utils";
import { fmtAgo, fmtTs } from "../lib/time";
import text from "../ui/text.module.css";
import {
  runArtifactsListForRun,
  runsCancel,
  runsGet,
  runsListEvents,
  scraperBuilderStartDryRun,
  scraperBuilderDraftsCreate,
  scraperBuilderDraftsDelete,
  scraperBuilderDraftsGetCurrent,
  scraperBuilderDraftsList,
  scraperBuilderDraftsSetCurrent,
  scraperBuilderDraftsUpsert,
  sourcesUpsert,
  type RunArtifactDoc,
  type RunDoc,
  type RunEventDoc,
  type ScraperBuilderDraftDoc
} from "../convexFns";
import classes from "./ScraperBuilderPage.module.css";

type BuilderRecipe = "shopify_collection" | "shopify_vendor" | "globetrotter_brand";

type BuilderDraft = {
  seedUrl: string;
  recipe: BuilderRecipe;
  sourceSlug: string;
  displayName: string;
  sourceType: SourceType;
  enabled: boolean;
  currency: string;
  config: Record<string, unknown>;
};

const DEFAULT_DRAFT: BuilderDraft = {
  seedUrl: "",
  recipe: "shopify_collection",
  sourceSlug: "",
  displayName: "",
  sourceType: "http",
  enabled: false,
  currency: "",
  config: {}
};

function safeParseUrl(raw: string): URL | null {
  try {
    return new URL(raw.trim());
  } catch {
    return null;
  }
}

function slugify(raw: string): string {
  const cleaned = raw
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/^www\./, "")
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return cleaned || "new_source";
}

function titleCaseFromSlug(slug: string) {
  return slug
    .replace(/[_-]+/g, " ")
    .split(" ")
    .filter(Boolean)
    .map((p) => `${p.slice(0, 1).toUpperCase()}${p.slice(1)}`)
    .join(" ");
}

function normalizedPrefixFromSegments(segments: string[], idx: number): string {
  if (idx <= 0) return "";
  return `/${segments.slice(0, idx).join("/")}`;
}

function buildShopifyCollectionJsonUrl(
  u: URL
): { url: string; productPathPrefix?: string; constraint?: string } | null {
  const segments = u.pathname.split("/").filter(Boolean);
  const idx = segments.findIndex((s) => s === "collections");
  if (idx === -1) return null;
  const handle = segments[idx + 1];
  if (!handle || handle === "vendors") return null;

  const prefix = normalizedPrefixFromSegments(segments, idx);
  const jsonUrl = new URL(`${prefix}/collections/${handle}/products.json`, u.origin).toString();
  const productPathPrefix = idx > 0 ? `${prefix}/products/` : undefined;

  const constraintFromQuery = u.searchParams.get("constraint")?.trim() || "";
  const constraintFromPath = segments[idx + 2]?.trim() || "";
  const constraint =
    constraintFromQuery ||
    (constraintFromPath && constraintFromPath !== "products.json" ? constraintFromPath : "");

  return {
    url: jsonUrl,
    ...(productPathPrefix ? { productPathPrefix } : {}),
    ...(constraint ? { constraint } : {})
  };
}

function detectRecipe(seedUrl: string): { recipe: BuilderRecipe; config: Record<string, unknown>; sourceType: SourceType } | null {
  const u = safeParseUrl(seedUrl);
  if (!u) return null;

  const pathname = u.pathname.toLowerCase();
  if (u.host.includes("globetrotter.") && pathname.includes("/marken/")) {
    return {
      recipe: "globetrotter_brand",
      sourceType: "playwright",
      config: { baseUrl: u.origin, listingUrl: seedUrl.trim() }
    };
  }

  if (pathname.includes("/collections/vendors")) {
    const segments = u.pathname.split("/").filter(Boolean);
    const idx = segments.findIndex((s) => s === "collections");
    const prefix = idx === -1 ? "" : normalizedPrefixFromSegments(segments, idx);
    return {
      recipe: "shopify_vendor",
      sourceType: "http",
      config: {
        baseUrl: u.origin,
        sourceUrl: seedUrl.trim(),
        vendorListingUrl: seedUrl.trim(),
        ...(prefix ? { productPathPrefix: `${prefix}/products/` } : {})
      }
    };
  }

  if (pathname.endsWith("/products.json")) {
    const collection = buildShopifyCollectionJsonUrl(u);
    const segments = u.pathname.split("/").filter(Boolean);
    const idx = segments.findIndex((s) => s === "collections");
    const prefix = idx === -1 ? "" : normalizedPrefixFromSegments(segments, idx);
    const sourceUrl = prefix ? new URL(`${prefix}/`, u.origin).toString() : u.origin;
    return {
      recipe: "shopify_collection",
      sourceType: "http",
      config: {
        baseUrl: u.origin,
        collectionProductsJsonUrl: seedUrl.trim(),
        sourceUrl,
        ...(collection?.productPathPrefix ? { productPathPrefix: collection.productPathPrefix } : {}),
        ...(collection?.constraint ? { constraint: collection.constraint } : {})
      }
    };
  }

  const collection = buildShopifyCollectionJsonUrl(u);
  if (collection) {
    return {
      recipe: "shopify_collection",
      sourceType: "http",
      config: {
        baseUrl: u.origin,
        sourceUrl: seedUrl.trim(),
        collectionProductsJsonUrl: collection.url,
        ...(collection.productPathPrefix ? { productPathPrefix: collection.productPathPrefix } : {}),
        ...(collection.constraint ? { constraint: collection.constraint } : {})
      }
    };
  }

  return null;
}

function artifactLabel(a: RunArtifactDoc) {
  if (a.key === "products.json") return "products.json (preview)";
  if (a.key === "run.log") return "run.log";
  return a.key;
}

function statusTone(status: RunDoc["status"] | "unknown") {
  if (status === "running") return { color: "cyan", label: "running" } as const;
  if (status === "pending") return { color: "blue", label: "queued" } as const;
  if (status === "failed") return { color: "red", label: "failed" } as const;
  if (status === "completed") return { color: "teal", label: "completed" } as const;
  if (status === "canceled") return { color: "gray", label: "canceled" } as const;
  return { color: "gray", label: "unknown" } as const;
}

function asDraftFromDoc(raw: ScraperBuilderDraftDoc | null): BuilderDraft {
  const d = raw?.draft;
  if (!d || typeof d !== "object" || Array.isArray(d)) return DEFAULT_DRAFT;
  const draft = d as Record<string, unknown>;
  const recipe =
    draft.recipe === "shopify_collection" || draft.recipe === "shopify_vendor" || draft.recipe === "globetrotter_brand"
      ? draft.recipe
      : DEFAULT_DRAFT.recipe;
  const sourceType = draft.sourceType === "http" || draft.sourceType === "playwright" || draft.sourceType === "hybrid" ? draft.sourceType : DEFAULT_DRAFT.sourceType;
  const config = draft.config && typeof draft.config === "object" && !Array.isArray(draft.config) ? (draft.config as Record<string, unknown>) : {};
  return {
    seedUrl: typeof draft.seedUrl === "string" ? draft.seedUrl : DEFAULT_DRAFT.seedUrl,
    recipe,
    sourceSlug: typeof draft.sourceSlug === "string" ? draft.sourceSlug : DEFAULT_DRAFT.sourceSlug,
    displayName: typeof draft.displayName === "string" ? draft.displayName : DEFAULT_DRAFT.displayName,
    sourceType,
    enabled: typeof draft.enabled === "boolean" ? draft.enabled : DEFAULT_DRAFT.enabled,
    currency: typeof draft.currency === "string" ? draft.currency : DEFAULT_DRAFT.currency,
    config
  };
}

export function ScraperBuilderPage(props: { sessionToken: string }) {
  const { sessionToken } = props;

  const draftsQuery = useQuery(scraperBuilderDraftsList, { sessionToken });
  const currentQuery = useQuery(scraperBuilderDraftsGetCurrent, { sessionToken });
  const drafts = draftsQuery ?? [];
  const current = currentQuery ?? { currentDraftId: null, draft: null };

  const [activeDraftId, setActiveDraftId] = useState<string | null>(null);
  const [draft, setDraft] = useState<BuilderDraft>(DEFAULT_DRAFT);
  const [draftName, setDraftName] = useState<string>("Draft");

  const createDraft = useMutation(scraperBuilderDraftsCreate);
  const setCurrentDraft = useMutation(scraperBuilderDraftsSetCurrent);
  const upsertDraft = useMutation(scraperBuilderDraftsUpsert);
  const deleteDraft = useMutation(scraperBuilderDraftsDelete);

  useEffect(() => {
    if (draftsQuery === undefined || currentQuery === undefined) return;
    if (current.currentDraftId || drafts.length > 0) return;
    void createDraft({ sessionToken, name: "Draft", draft: DEFAULT_DRAFT }).catch(() => {});
  }, [createDraft, current.currentDraftId, currentQuery, drafts.length, draftsQuery, sessionToken]);

  useEffect(() => {
    const doc = current.draft;
    if (!doc) return;
    if (activeDraftId === doc._id) return;
    setActiveDraftId(doc._id);
    setDraft(asDraftFromDoc(doc));
    setDraftName(doc.name);
  }, [activeDraftId, current.draft]);

  const [configText, setConfigText] = useState(() => JSON.stringify(draft.config, null, 2));
  const [configError, setConfigError] = useState<string | null>(null);
  useEffect(() => {
    setConfigText(JSON.stringify(draft.config, null, 2));
    setConfigError(null);
  }, [draft.config]);

  const startDryRun = useAction(scraperBuilderStartDryRun);
  const cancelRun = useAction(runsCancel);
  const upsertSource = useMutation(sourcesUpsert);

  const [debouncedDraft] = useDebouncedValue(draft, 800);
  const [debouncedName] = useDebouncedValue(draftName, 800);
  useEffect(() => {
    if (!activeDraftId) return;
    void upsertDraft({ sessionToken, draftId: activeDraftId, name: debouncedName, draft: debouncedDraft }).catch(() => {});
  }, [activeDraftId, debouncedDraft, debouncedName, sessionToken, upsertDraft]);

  const runId = current.draft?.runId ?? null;
  const skip = "skip" as const;
  const run = useQuery(runsGet, runId ? { sessionToken, runId } : skip) ?? null;
  const events: RunEventDoc[] = useQuery(runsListEvents, runId ? { sessionToken, runId, limit: 200 } : skip) ?? [];
  const artifacts: RunArtifactDoc[] = useQuery(runArtifactsListForRun, runId ? { sessionToken, runId } : skip) ?? [];

  const orderedEvents = useMemo(() => [...events].reverse(), [events]);
  const tone = statusTone(run?.status ?? (runId ? "unknown" : "unknown"));
  const isActive = run?.status === "pending" || run?.status === "running";

  const canStart =
    !isActive &&
    draft.seedUrl.trim().length > 0 &&
    draft.sourceSlug.trim().length > 0 &&
    draft.displayName.trim().length > 0 &&
    !configError &&
    draft.config &&
    Object.keys(draft.config).length > 0;

  const applyConfigJson = () => {
    try {
      const parsed = JSON.parse(configText) as unknown;
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        setConfigError("Config must be a JSON object");
        return false;
      }
      const nextConfig = parsed as Record<string, unknown>;
      setDraft((prev) => ({ ...prev, config: nextConfig }));
      setConfigText(JSON.stringify(nextConfig, null, 2));
      setConfigError(null);
      return true;
    } catch (err) {
      setConfigError(err instanceof Error ? err.message : String(err));
      return false;
    }
  };

  return (
    <Container size="xl" py="xl">
      <Stack gap="lg">
        <Group justify="space-between" wrap="wrap" gap="md">
          <Stack gap={4}>
            <Title order={3}>Scraper Builder</Title>
            <Text c="dimmed" size="sm">
              Add new sources by generating a config and validating it via a dry-run scrape.
            </Text>
          </Stack>
          <Group gap="sm" wrap="wrap">
            <Button
              variant="default"
              leftSection={<IconTrash size={16} />}
              onClick={async () => {
                if (!activeDraftId) return;
                await upsertDraft({ sessionToken, draftId: activeDraftId, name: draftName, draft: DEFAULT_DRAFT, runId: null });
                setDraft(DEFAULT_DRAFT);
                setConfigText(JSON.stringify(DEFAULT_DRAFT.config, null, 2));
                setConfigError(null);
                notifications.show({ title: "Cleared", message: "Draft reset." });
              }}
            >
              Clear
            </Button>
            <Button
              variant="light"
              leftSection={<IconCopy size={16} />}
              onClick={async () => {
                const name = draftName.trim() ? `Copy of ${draftName.trim()}` : "Copy";
                const res = await createDraft({ sessionToken, name, draft });
                notifications.show({ title: "Draft created", message: name });
                await setCurrentDraft({ sessionToken, draftId: res.draftId });
              }}
            >
              New draft
            </Button>
            <Button
              variant="default"
              color="red"
              leftSection={<IconTrash size={16} />}
              disabled={!activeDraftId || drafts.length <= 1}
              onClick={async () => {
                if (!activeDraftId) return;
                if (!window.confirm("Delete this draft?")) return;
                const res = await deleteDraft({ sessionToken, draftId: activeDraftId });
                if (res.deleted) notifications.show({ title: "Draft deleted", message: "Deleted." });
              }}
            >
              Delete
            </Button>
            {runId ? (
              <Button component={Link} to={`/scrapers/history/${runId}`} variant="light" rightSection={<IconArrowRight size={16} />}>
                Open run
              </Button>
            ) : null}
          </Group>
        </Group>

        <div className={classes.grid}>
          <Stack gap="lg" className={classes.sticky}>
            <Paper withBorder radius="lg" p="md">
              <Stack gap="sm">
                <Group justify="space-between" wrap="wrap" gap="md">
                  <Text fw={700}>Draft</Text>
                  <Badge variant="light" color={isActive ? "blue" : "gray"} radius="xl">
                    {isActive ? "run active" : "idle"}
                  </Badge>
                </Group>

                <Select
                  label="Saved drafts"
                  value={activeDraftId}
                  data={drafts.map((d) => ({ value: d._id, label: d.name }))}
                  placeholder={drafts.length === 0 ? "Loading…" : "Select a draft"}
                  searchable
                  allowDeselect={false}
                  onChange={(v) => {
                    if (!v) return;
                    void setCurrentDraft({ sessionToken, draftId: v }).catch((err) => {
                      notifications.show({
                        title: "Switch failed",
                        message: err instanceof Error ? err.message : String(err),
                        color: "red"
                      });
                    });
                  }}
                />

                <TextInput
                  label="Draft name"
                  placeholder="Cardiofitness – Foam rollers"
                  value={draftName}
                  onChange={(e) => setDraftName(e.currentTarget.value)}
                  onBlur={() => {
                    setDraftName((prev) => (prev.trim() ? prev : current.draft?.name ?? "Draft"));
                  }}
                />

                <TextInput
                  label="Seed URL"
                  placeholder="https://example.com/collections/brand"
                  value={draft.seedUrl}
                  onChange={(e) => setDraft((prev) => ({ ...prev, seedUrl: e.currentTarget.value }))}
                />

                <Group gap="sm" wrap="wrap">
                  <Button
                    variant="light"
                    onClick={() => {
                      const u = safeParseUrl(draft.seedUrl);
                      if (!u) {
                        notifications.show({ title: "Invalid URL", message: "Enter a valid seed URL first.", color: "red" });
                        return;
                      }

                      const detected = detectRecipe(draft.seedUrl);
                      const sourceSlug = draft.sourceSlug.trim() || slugify(u.hostname);
                      const displayName = draft.displayName.trim() || titleCaseFromSlug(sourceSlug);
                      const next: BuilderDraft = {
                        ...draft,
                        sourceSlug,
                        displayName,
                        ...(detected ? { recipe: detected.recipe, sourceType: detected.sourceType, config: detected.config } : {})
                      };
                      if (next.currency.trim()) {
                        next.config = { ...next.config, currency: next.currency.trim() };
                      }
                      setDraft(next);
                      setConfigText(JSON.stringify(next.config, null, 2));
                      setConfigError(null);
                      notifications.show({
                        title: detected ? "Auto-detected config" : "Updated slug/name",
                        message: detected ? `Recipe: ${detected.recipe.replace(/_/g, " ")}` : "Could not detect a recipe from this URL."
                      });
                    }}
                  >
                    Auto-detect
                  </Button>
                  <Button
                    variant="subtle"
                    onClick={() => {
                      const ok = applyConfigJson();
                      notifications.show({
                        title: ok ? "Applied JSON" : "JSON error",
                        message: ok ? "Config updated." : "Fix JSON errors first.",
                        color: ok ? undefined : "red"
                      });
                    }}
                  >
                    Apply JSON
                  </Button>
                </Group>

                <Select
                  label="Recipe"
                  value={draft.recipe}
                  data={[
                    { value: "shopify_collection", label: "Shopify collection (products.json)" },
                    { value: "shopify_vendor", label: "Shopify vendor listing" },
                    { value: "globetrotter_brand", label: "Globetrotter brand page (Playwright)" }
                  ]}
                  onChange={(v) => {
                    const recipe = v === "shopify_vendor" || v === "globetrotter_brand" ? v : "shopify_collection";
                    const sourceType: SourceType = recipe === "globetrotter_brand" ? "playwright" : "http";
                    setDraft((prev) => ({ ...prev, recipe, sourceType }));
                  }}
                />

                <Group grow>
                  <TextInput
                    label="Source slug"
                    value={draft.sourceSlug}
                    onChange={(e) => setDraft((prev) => ({ ...prev, sourceSlug: e.currentTarget.value }))}
                    placeholder="cardiofitness"
                  />
                  <TextInput
                    label="Display name"
                    value={draft.displayName}
                    onChange={(e) => setDraft((prev) => ({ ...prev, displayName: e.currentTarget.value }))}
                    placeholder="Cardiofitness"
                  />
                </Group>

                <Group grow>
                  <Select
                    label="Source type"
                    value={draft.sourceType}
                    data={[
                      { value: "http", label: "http" },
                      { value: "playwright", label: "playwright" },
                      { value: "hybrid", label: "hybrid" }
                    ]}
                    onChange={(v) => {
                      const sourceType = v === "playwright" || v === "hybrid" ? v : "http";
                      setDraft((prev) => ({ ...prev, sourceType }));
                    }}
                  />
                  <Select
                    label="Currency (optional)"
                    value={draft.currency || null}
                    placeholder="Auto"
                    data={[
                      { value: "", label: "Auto" },
                      { value: "EUR", label: "EUR" },
                      { value: "CHF", label: "CHF" },
                      { value: "USD", label: "USD" }
                    ]}
                    onChange={(v) => {
                      const currency = v ?? "";
                      setDraft((prev) => ({
                        ...prev,
                        currency,
                        config: currency.trim() ? { ...prev.config, currency: currency.trim() } : { ...prev.config }
                      }));
                    }}
                  />
                </Group>

                <Textarea
                  label="Config JSON"
                  description="Worker uses this config to choose a scraper implementation."
                  value={configText}
                  onChange={(e) => setConfigText(e.currentTarget.value)}
                  onBlur={() => {
                    applyConfigJson();
                  }}
                  minRows={10}
                  autosize
                  className={classes.mono}
                  error={configError}
                />

                <Divider />

                <Group gap="sm" wrap="wrap">
                  <Button
                    leftSection={<IconPlayerPlay size={16} />}
                    disabled={!canStart}
                    onClick={async () => {
                      if (!applyConfigJson()) {
                        notifications.show({ title: "Config JSON invalid", message: "Fix JSON errors first.", color: "red" });
                        return;
                      }
                      try {
                        if (!activeDraftId) throw new Error("No draft selected");
                        const res = await startDryRun({ sessionToken, draftId: activeDraftId, draft });
                        notifications.show({
                          title: "Dry-run started",
                          message: res.queueJobId ? `queued (${res.queueJobId})` : "queued"
                        });
                      } catch (err) {
                        notifications.show({
                          title: "Dry-run failed",
                          message: err instanceof Error ? err.message : String(err),
                          color: "red"
                        });
                      }
                    }}
                  >
                    Test scrape (dry-run)
                  </Button>

                  <Button
                    variant="default"
                    disabled={draft.sourceSlug.trim().length === 0 || draft.displayName.trim().length === 0 || !!configError || Object.keys(draft.config).length === 0}
                    onClick={async () => {
                      if (!applyConfigJson()) {
                        notifications.show({ title: "Config JSON invalid", message: "Fix JSON errors first.", color: "red" });
                        return;
                      }
                      try {
                        const result = await upsertSource({
                          sessionToken,
                          slug: draft.sourceSlug.trim(),
                          displayName: draft.displayName.trim(),
                          enabled: draft.enabled,
                          type: draft.sourceType,
                          config: draft.currency.trim() ? { ...draft.config, currency: draft.currency.trim() } : draft.config
                        });
                        notifications.show({
                          title: result.created ? "Source created" : "Source updated",
                          message: `${draft.displayName.trim()} (${draft.sourceSlug.trim()})`
                        });
                      } catch (err) {
                        notifications.show({
                          title: "Save source failed",
                          message: err instanceof Error ? err.message : String(err),
                          color: "red"
                        });
                      }
                    }}
                  >
                    Save source
                  </Button>
                </Group>

                <Text size="xs" c="dimmed">
                  “Save source” writes to <span className={text.mono}>sources</span>. “Test scrape” runs a dry-run and will not ingest
                  products.
                </Text>
              </Stack>
            </Paper>
          </Stack>

          <Stack gap="lg">
            <Paper withBorder radius="lg" p="md">
              <Group justify="space-between" wrap="wrap" gap="md">
                <Text fw={700}>Run</Text>
                {run ? (
                  <Badge variant="light" color={tone.color} radius="xl">
                    {tone.label}
                  </Badge>
                ) : (
                  <Badge variant="light" color="gray" radius="xl">
                    none
                  </Badge>
                )}
              </Group>
              <Divider my="sm" />

              {!runId ? (
                <Text size="sm" c="dimmed">
                  No dry-run yet. Start one from the left.
                </Text>
              ) : run === null ? (
                <Text size="sm" c="red.2">
                  Run not found.
                </Text>
              ) : (
                <Stack gap="sm">
                  <Group justify="space-between" wrap="wrap" gap="md">
                    <Text size="sm">
                      started <span className={text.mono}>{fmtTs(run.startedAt ?? run._creationTime)}</span> (
                      {fmtAgo(run.startedAt ?? run._creationTime)})
                    </Text>
                    {isActive ? (
                      <Button
                        variant="light"
                        color="red"
                        leftSection={<IconX size={16} />}
                        onClick={async () => {
                          try {
                            await cancelRun({ sessionToken, runId });
                            notifications.show({ title: "Cancel requested", message: "Attempting to stop the queue job." });
                          } catch (err) {
                            notifications.show({
                              title: "Cancel failed",
                              message: err instanceof Error ? err.message : String(err),
                              color: "red"
                            });
                          }
                        }}
                      >
                        Cancel
                      </Button>
                    ) : null}
                  </Group>

                  <Group gap="lg" wrap="wrap">
                    <Text size="sm">
                      products <span className={text.mono}>{typeof run.productsFound === "number" ? run.productsFound : "—"}</span>
                    </Text>
                    <Text size="sm">
                      missing ids{" "}
                      <span className={text.mono}>{typeof run.missingItemIds === "number" ? run.missingItemIds : "—"}</span>
                    </Text>
                    <Text size="sm">
                      requestedBy <span className={text.mono}>{run.requestedBy ?? "—"}</span>
                    </Text>
                  </Group>

                  {typeof run.error === "string" && run.error.trim() ? (
                    <Paper withBorder radius="md" p="sm">
                      <Text size="sm" c="red.2" className={classes.mono}>
                        {run.error}
                      </Text>
                    </Paper>
                  ) : null}

                  {artifacts.length > 0 ? (
                    <Group gap="sm" wrap="wrap">
                      {artifacts.map((a) => (
                        <Anchor key={a._id} href={`/media/${a.path}`} target="_blank" rel="noreferrer" size="sm">
                          {artifactLabel(a)}
                        </Anchor>
                      ))}
                    </Group>
                  ) : null}
                </Stack>
              )}
            </Paper>

            <Paper withBorder radius="lg" p="md">
              <Group justify="space-between" wrap="wrap" gap="md">
                <Text fw={700}>Logs</Text>
                {runId ? (
                  <Anchor component={Link} to={`/scrapers/history/${runId}`} size="sm">
                    View full run detail
                  </Anchor>
                ) : null}
              </Group>
              <Divider my="sm" />
              {runId && orderedEvents.length === 0 ? (
                <Text size="sm" c="dimmed">
                  No events yet.
                </Text>
              ) : !runId ? (
                <Text size="sm" c="dimmed">
                  Start a dry-run to see streaming logs.
                </Text>
              ) : (
                <ScrollArea h={520} type="auto" scrollbarSize={8}>
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
          </Stack>
        </div>
      </Stack>
    </Container>
  );
}
