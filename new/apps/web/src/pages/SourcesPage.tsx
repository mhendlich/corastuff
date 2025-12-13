import { useAction, useMutation, useQuery } from "convex/react";
import { useMemo, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import {
  ActionIcon,
  Badge,
  Button,
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
import { notifications } from "@mantine/notifications";
import { IconFlask2, IconPencil, IconPlus, IconRefresh, IconSearch, IconTestPipe } from "@tabler/icons-react";
import { PageHeader } from "../components/PageHeader";
import { fmtAgo, fmtTs } from "../lib/time";
import { sourcesList, sourcesSeedDemo, sourcesSetEnabled, sourcesStartDryRun, type SourceDoc } from "../convexFns";
import classes from "./SourcesPage.module.css";

function normalize(s: string) {
  return s.toLowerCase().trim();
}

export function SourcesPage(props: { sessionToken: string }) {
  const navigate = useNavigate();
  const { sessionToken } = props;

  const sources = useQuery(sourcesList, { sessionToken }) ?? [];
  const seedDemo = useMutation(sourcesSeedDemo);
  const setEnabled = useAction(sourcesSetEnabled);
  const startDryRun = useAction(sourcesStartDryRun);

  const [q, setQ] = useState("");
  const [runningForSlug, setRunningForSlug] = useState<string | null>(null);

  const filtered: SourceDoc[] = useMemo(() => {
    const query = normalize(q);
    const ordered = [...sources].sort((a, b) => a.slug.localeCompare(b.slug));
    if (!query) return ordered;
    return ordered.filter((s) => normalize(`${s.slug} ${s.displayName} ${s.type}`).includes(query));
  }, [q, sources]);

  const handleSeed = async () => {
    setRunningForSlug("__seed__");
    try {
      const result = await seedDemo({ sessionToken });
      notifications.show({
        title: "Seeded",
        message: `Inserted ${result.inserted}, updated ${result.updated}.`
      });
    } catch (err) {
      notifications.show({
        title: "Seed failed",
        message: err instanceof Error ? err.message : String(err),
        color: "red"
      });
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
      notifications.show({
        title: "Update failed",
        message: err instanceof Error ? err.message : String(err),
        color: "red"
      });
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
      notifications.show({
        title: "Test failed",
        message: err instanceof Error ? err.message : String(err),
        color: "red"
      });
    } finally {
      setRunningForSlug(null);
    }
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
            placeholder="Search slug, name, type…"
            leftSection={<IconSearch size={16} />}
            w={360}
          />
          <Button variant="subtle" color="gray" leftSection={<IconRefresh size={16} />} onClick={() => setQ("")}>
            Reset
          </Button>
        </Group>

        <Table withTableBorder withColumnBorders highlightOnHover>
          <Table.Thead>
            <Table.Tr>
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
                    <Switch
                      checked={s.enabled}
                      disabled={runningForSlug !== null}
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
          <Text c="dimmed" size="sm">
            No sources found.
          </Text>
        ) : null}
      </Stack>
    </Container>
  );
}

