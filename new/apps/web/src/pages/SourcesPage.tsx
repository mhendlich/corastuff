import { useAction, useMutation, useQuery } from "convex/react";
import { useMemo, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import {
  ActionIcon,
  Badge,
  Button,
  Checkbox,
  Container,
  Group,
  Loader,
  Stack,
  Switch,
  Table,
  Text,
  TextInput,
  Tooltip
} from "@mantine/core";
import { modals } from "@mantine/modals";
import { notifications } from "@mantine/notifications";
import { IconFlask2, IconPencil, IconPlus, IconRefresh, IconSearch, IconTestPipe, IconToggleLeft } from "@tabler/icons-react";
import { EmptyState } from "../components/EmptyState";
import { PageHeader } from "../components/PageHeader";
import { InlineError } from "../components/InlineError";
import { errorMessage } from "../lib/errors";
import { makeFuse, fuseFilter } from "../lib/fuzzy";
import { notifyError } from "../lib/notify";
import { fmtAgo, fmtTs } from "../lib/time";
import { sourcesList, sourcesSeedDemo, sourcesSetEnabled, sourcesStartDryRun, type SourceDoc } from "../convexFns";
import classes from "./SourcesPage.module.css";

export function SourcesPage(props: { sessionToken: string }) {
  const navigate = useNavigate();
  const { sessionToken } = props;

  const sources = useQuery(sourcesList, { sessionToken }) ?? [];
  const seedDemo = useMutation(sourcesSeedDemo);
  const setEnabled = useAction(sourcesSetEnabled);
  const startDryRun = useAction(sourcesStartDryRun);

  const [q, setQ] = useState("");
  const [runningForSlug, setRunningForSlug] = useState<string | null>(null);
  const [selectedSlugs, setSelectedSlugs] = useState<Set<string>>(() => new Set());
  const [bulkBusy, setBulkBusy] = useState(false);
  const [bulkError, setBulkError] = useState<string | null>(null);

  const ordered: SourceDoc[] = useMemo(() => [...sources].sort((a, b) => a.slug.localeCompare(b.slug)), [sources]);
  const fuse = useMemo(
    () => makeFuse(ordered, { keys: ["slug", "displayName", "type"], includeScore: true }),
    [ordered]
  );
  const filtered: SourceDoc[] = useMemo(() => fuseFilter(ordered, fuse, q), [fuse, ordered, q]);

  const allFilteredSelected = filtered.length > 0 && filtered.every((s) => selectedSlugs.has(s.slug));
  const someFilteredSelected = filtered.some((s) => selectedSlugs.has(s.slug));

  const handleSeed = async () => {
    setRunningForSlug("__seed__");
    try {
      const result = await seedDemo({ sessionToken });
      notifications.show({
        title: "Seeded",
        message: `Inserted ${result.inserted}, updated ${result.updated}.`
      });
    } catch (err) {
      notifyError({ title: "Seed failed", error: err });
    } finally {
      setRunningForSlug(null);
    }
  };

  const handleToggle = async (slug: string, enabled: boolean) => {
    setRunningForSlug(slug);
    try {
      await setEnabled({ sessionToken, slug, enabled });
      notifications.show({ title: "Updated", message: `${slug} ${enabled ? "enabled" : "disabled"}.` });
    } catch (err) {
      notifyError({ title: "Update failed", error: err });
    } finally {
      setRunningForSlug(null);
    }
  };

  const handleTest = async (slug: string) => {
    setRunningForSlug(slug);
    try {
      const result = await startDryRun({ sessionToken, sourceSlug: slug });
      notifications.show({ title: "Test started", message: "Dry-run enqueued. Opening run detail…" });
      navigate(`/scrapers/history/${result.runId}`);
    } catch (err) {
      notifyError({ title: "Test failed", error: err });
    } finally {
      setRunningForSlug(null);
    }
  };

  const bulkSetEnabled = async (enabled: boolean) => {
    if (bulkBusy) return;
    const slugs = Array.from(selectedSlugs);
    if (slugs.length === 0) return;

    setBulkBusy(true);
    setBulkError(null);

    let ok = 0;
    const failures: Array<{ slug: string; error: string }> = [];

    for (const slug of slugs) {
      try {
        await setEnabled({ sessionToken, slug, enabled });
        ok += 1;
      } catch (err) {
        failures.push({ slug, error: errorMessage(err) });
      }
    }

    if (failures.length === 0) {
      notifications.show({
        title: "Updated sources",
        message: `${ok} ${enabled ? "enabled" : "disabled"}.`
      });
      setSelectedSlugs(new Set());
    } else {
      setBulkError(`${failures.length} failed. First: ${failures[0]?.slug} — ${failures[0]?.error ?? "Unknown error"}`);
      notifications.show({
        title: "Bulk update partially failed",
        message: `${ok} updated · ${failures.length} failed`,
        color: failures.length === slugs.length ? "red" : "yellow"
      });
    }

    setBulkBusy(false);
  };

  return (
    <Container size="xl" py="xl">
      <Stack gap="lg">
        <PageHeader
          title="Sources"
          subtitle="Create/edit source configs, and run a dry-run test before enabling schedules."
          right={
            <Group gap="sm">
              <Button
                variant="default"
                leftSection={runningForSlug === "__seed__" ? <Loader size={16} /> : <IconFlask2 size={16} />}
                onClick={() => void handleSeed()}
                disabled={runningForSlug !== null}
              >
                Seed demo
              </Button>
              <Button leftSection={<IconPlus size={16} />} component={Link} to="/scrapers/sources/new">
                New source
              </Button>
            </Group>
          }
        />

        <Group justify="space-between" align="flex-end" wrap="wrap" gap="md">
          <TextInput
            value={q}
            onChange={(e) => setQ(e.currentTarget.value)}
            placeholder="Search slug, name, type… (fuzzy)"
            leftSection={<IconSearch size={16} />}
            w={360}
          />
          <Button variant="subtle" color="gray" leftSection={<IconRefresh size={16} />} onClick={() => setQ("")}>
            Reset
          </Button>
        </Group>

        {selectedSlugs.size > 0 ? (
          <Stack gap="sm">
            {bulkError ? <InlineError title="Bulk update failed" error={bulkError} onRetry={() => void bulkSetEnabled(true)} /> : null}
            <Group justify="space-between" align="center" wrap="wrap" gap="md">
              <Text size="sm" c="dimmed">
                {selectedSlugs.size} selected
              </Text>
              <Group gap="sm">
                <Button
                  size="sm"
                  variant="default"
                  leftSection={<IconToggleLeft size={16} />}
                  loading={bulkBusy}
                  disabled={runningForSlug !== null || bulkBusy}
                  onClick={() => {
                    modals.openConfirmModal({
                      title: `Disable ${selectedSlugs.size} sources?`,
                      centered: true,
                      labels: { confirm: "Disable", cancel: "Cancel" },
                      confirmProps: { color: "red" },
                      children: (
                        <Text size="sm">
                          This disables the selected sources and also disables their schedules.
                        </Text>
                      ),
                      onConfirm: () => void bulkSetEnabled(false)
                    });
                  }}
                >
                  Disable
                </Button>
                <Button
                  size="sm"
                  leftSection={<IconToggleLeft size={16} />}
                  loading={bulkBusy}
                  disabled={runningForSlug !== null || bulkBusy}
                  onClick={() => void bulkSetEnabled(true)}
                >
                  Enable
                </Button>
                <Button
                  size="sm"
                  variant="subtle"
                  color="gray"
                  onClick={() => setSelectedSlugs(new Set())}
                  disabled={bulkBusy}
                >
                  Clear
                </Button>
              </Group>
            </Group>
          </Stack>
        ) : null}

        <Table withTableBorder withColumnBorders highlightOnHover>
          <Table.Thead>
            <Table.Tr>
              <Table.Th w={44}>
                <Checkbox
                  checked={allFilteredSelected}
                  indeterminate={!allFilteredSelected && someFilteredSelected}
                  onChange={(e) => {
                    const checked = e.currentTarget.checked;
                    setSelectedSlugs((prev) => {
                      const next = new Set(prev);
                      if (checked) {
                        for (const s of filtered) next.add(s.slug);
                      } else {
                        for (const s of filtered) next.delete(s.slug);
                      }
                      return next;
                    });
                  }}
                  aria-label="Select all"
                />
              </Table.Th>
              <Table.Th w={120}>Enabled</Table.Th>
              <Table.Th>Source</Table.Th>
              <Table.Th w={140}>Type</Table.Th>
              <Table.Th w={220}>Last success</Table.Th>
              <Table.Th w={170}>Actions</Table.Th>
            </Table.Tr>
          </Table.Thead>
          <Table.Tbody>
            {filtered.map((s) => {
              const busy = runningForSlug === s.slug;
              return (
                <Table.Tr key={s._id}>
                  <Table.Td>
                    <Checkbox
                      checked={selectedSlugs.has(s.slug)}
                      onChange={(e) => {
                        const checked = e.currentTarget.checked;
                        setSelectedSlugs((prev) => {
                          const next = new Set(prev);
                          if (checked) next.add(s.slug);
                          else next.delete(s.slug);
                          return next;
                        });
                      }}
                      aria-label={`Select ${s.slug}`}
                    />
                  </Table.Td>
                  <Table.Td>
                    <Switch
                      checked={s.enabled}
                      disabled={runningForSlug !== null || bulkBusy}
                      onChange={(e) => void handleToggle(s.slug, e.currentTarget.checked)}
                    />
                  </Table.Td>
                  <Table.Td>
                    <Stack gap={2}>
                      <Text className={classes.slug}>{s.slug}</Text>
                      <Text size="sm" c="dimmed">
                        {s.displayName}
                      </Text>
                    </Stack>
                  </Table.Td>
                  <Table.Td>
                    <Badge variant="light" color={s.type === "playwright" ? "cyan" : s.type === "hybrid" ? "violet" : "gray"}>
                      {s.type}
                    </Badge>
                  </Table.Td>
                  <Table.Td>
                    {s.lastSuccessfulAt ? (
                      <Stack gap={2}>
                        <Text size="sm">{fmtAgo(s.lastSuccessfulAt)}</Text>
                        <Text size="xs" c="dimmed">
                          {fmtTs(s.lastSuccessfulAt)}
                        </Text>
                      </Stack>
                    ) : (
                      <Text size="sm" c="dimmed">
                        —
                      </Text>
                    )}
                  </Table.Td>
                  <Table.Td className={classes.rowActions}>
                    <Group gap="xs" wrap="nowrap">
                      <Tooltip label="Edit source" withArrow>
                        <ActionIcon
                          variant="default"
                          component={Link}
                          to={`/scrapers/sources/${s.slug}`}
                          aria-label={`Edit ${s.slug}`}
                        >
                          <IconPencil size={16} />
                        </ActionIcon>
                      </Tooltip>
                      <Tooltip label="Test scrape (dry-run)" withArrow>
                        <ActionIcon
                          variant="default"
                          color="violet"
                          loading={busy}
                          onClick={() => void handleTest(s.slug)}
                          aria-label={`Test ${s.slug}`}
                        >
                          <IconTestPipe size={16} />
                        </ActionIcon>
                      </Tooltip>
                    </Group>
                  </Table.Td>
                </Table.Tr>
              );
            })}
          </Table.Tbody>
        </Table>

        {filtered.length === 0 ? (
          <EmptyState
            icon={<IconSearch size={22} />}
            title="No sources found"
            description={q.trim() ? "Try a different query, or reset filters." : "Create your first source to get started."}
            action={
              q.trim() ? (
                <Button variant="default" onClick={() => setQ("")}>
                  Reset search
                </Button>
              ) : (
                <Button component={Link} to="/scrapers/sources/new" leftSection={<IconPlus size={16} />}>
                  New source
                </Button>
              )
            }
            secondaryAction={
              q.trim() ? (
                <Button variant="subtle" color="gray" onClick={() => setQ("")}>
                  Clear
                </Button>
              ) : undefined
            }
          />
        ) : null}
      </Stack>
    </Container>
  );
}
